package update

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	UpdateCheckURL = "http://39.102.53.188:16198/clawpanel/update.json"
	httpTimeout    = 30 * time.Second
	downloadTimeout = 300 * time.Second
)

// UpdateInfo represents the server-side update.json
type UpdateInfo struct {
	LatestVersion string            `json:"latest_version"`
	ReleaseTime   string            `json:"release_time"`
	ReleaseNote   string            `json:"release_note"`
	DownloadURLs  map[string]string `json:"download_urls"`
	SHA256        map[string]string `json:"sha256"`
}

// UpdatePopup represents the popup info saved after a successful update
type UpdatePopup struct {
	Show        bool   `json:"show"`
	Version     string `json:"version"`
	ReleaseNote string `json:"release_note"`
	ShownAt     string `json:"shown_at,omitempty"`
}

// UpdateProgress represents the current update progress
type UpdateProgress struct {
	Status     string   `json:"status"` // idle, checking, downloading, verifying, replacing, restarting, done, error
	Progress   int      `json:"progress"` // 0-100
	Message    string   `json:"message"`
	Log        []string `json:"log"`
	Error      string   `json:"error,omitempty"`
	StartedAt  string   `json:"started_at,omitempty"`
	FinishedAt string   `json:"finished_at,omitempty"`
}

// Updater handles self-update logic
type Updater struct {
	currentVersion string
	dataDir        string
	mu             sync.Mutex
	progress       UpdateProgress
}

// NewUpdater creates a new Updater
func NewUpdater(currentVersion, dataDir string) *Updater {
	return &Updater{
		currentVersion: currentVersion,
		dataDir:        dataDir,
		progress: UpdateProgress{
			Status: "idle",
			Log:    []string{},
		},
	}
}

// getPlatformKey returns the platform key for download URLs
func getPlatformKey() string {
	os := runtime.GOOS
	arch := runtime.GOARCH
	switch {
	case os == "linux" && arch == "amd64":
		return "linux_amd64"
	case os == "linux" && arch == "arm64":
		return "linux_arm64"
	case os == "windows" && arch == "amd64":
		return "windows_amd64"
	case os == "darwin" && arch == "amd64":
		return "darwin_amd64"
	case os == "darwin" && arch == "arm64":
		return "darwin_arm64"
	default:
		return os + "_" + arch
	}
}

// CheckUpdate checks for available updates
func (u *Updater) CheckUpdate() (*UpdateInfo, bool, error) {
	client := &http.Client{Timeout: httpTimeout}
	resp, err := client.Get(UpdateCheckURL)
	if err != nil {
		return nil, false, fmt.Errorf("请求更新服务器失败: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, false, fmt.Errorf("更新服务器返回错误: HTTP %d", resp.StatusCode)
	}

	var info UpdateInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, false, fmt.Errorf("解析更新信息失败: %v", err)
	}

	hasUpdate := info.LatestVersion != "" && info.LatestVersion != u.currentVersion && isNewerVersion(info.LatestVersion, u.currentVersion)

	return &info, hasUpdate, nil
}

// GetProgress returns the current update progress
func (u *Updater) GetProgress() UpdateProgress {
	u.mu.Lock()
	defer u.mu.Unlock()
	p := u.progress
	logCopy := make([]string, len(u.progress.Log))
	copy(logCopy, u.progress.Log)
	p.Log = logCopy
	return p
}

// DoUpdate performs the self-update
func (u *Updater) DoUpdate(info *UpdateInfo) {
	u.mu.Lock()
	if u.progress.Status == "downloading" || u.progress.Status == "verifying" || u.progress.Status == "replacing" {
		u.mu.Unlock()
		return
	}
	u.progress = UpdateProgress{
		Status:    "downloading",
		Progress:  0,
		Message:   "准备下载更新...",
		Log:       []string{},
		StartedAt: time.Now().Format(time.RFC3339),
	}
	u.mu.Unlock()

	go u.doUpdateAsync(info)
}

func (u *Updater) doUpdateAsync(info *UpdateInfo) {
	u.log("🔍 检测平台: %s/%s", runtime.GOOS, runtime.GOARCH)

	platformKey := getPlatformKey()
	downloadURL, ok := info.DownloadURLs[platformKey]
	if !ok {
		u.setError("不支持的平台: %s", platformKey)
		return
	}
	expectedSHA, _ := info.SHA256[platformKey]

	u.log("📥 下载更新: %s → %s", info.LatestVersion, downloadURL)
	u.setStatus("downloading", 10, "正在下载更新包...")

	// Download to temp file
	tmpDir := filepath.Join(u.dataDir, "update-tmp")
	os.MkdirAll(tmpDir, 0755)
	tmpFile := filepath.Join(tmpDir, "clawpanel-new")
	if runtime.GOOS == "windows" {
		tmpFile += ".exe"
	}

	if err := u.downloadFile(downloadURL, tmpFile); err != nil {
		u.setError("下载失败: %v", err)
		return
	}
	u.log("✅ 下载完成")

	// SHA256 verify
	u.setStatus("verifying", 60, "正在校验文件完整性...")
	if expectedSHA != "" {
		actualSHA, err := fileSHA256(tmpFile)
		if err != nil {
			u.setError("校验失败: %v", err)
			return
		}
		if !strings.EqualFold(actualSHA, expectedSHA) {
			u.setError("SHA256 校验失败: 期望 %s, 实际 %s\n更新包可能损坏，请重新尝试", expectedSHA[:16]+"...", actualSHA[:16]+"...")
			os.Remove(tmpFile)
			return
		}
		u.log("✅ SHA256 校验通过")
	} else {
		u.log("⚠️ 未提供 SHA256 校验值，跳过校验")
	}

	// Replace binary
	u.setStatus("replacing", 80, "正在替换程序...")
	currentBin, err := os.Executable()
	if err != nil {
		u.setError("获取当前程序路径失败: %v", err)
		return
	}
	currentBin, _ = filepath.EvalSymlinks(currentBin)
	u.log("📍 当前程序: %s", currentBin)

	// Backup old binary
	backupPath := currentBin + ".bak"
	if runtime.GOOS == "windows" {
		// Windows can't replace running exe, rename first
		os.Remove(backupPath)
		if err := os.Rename(currentBin, backupPath); err != nil {
			u.setError("备份旧程序失败: %v", err)
			return
		}
		u.log("📦 已备份旧程序: %s", backupPath)
	} else {
		// Linux/macOS: copy old binary as backup
		if data, err := os.ReadFile(currentBin); err == nil {
			os.WriteFile(backupPath, data, 0755)
			u.log("📦 已备份旧程序: %s", backupPath)
		}
	}

	// Copy new binary
	if err := copyFile(tmpFile, currentBin); err != nil {
		// Restore backup on failure
		if runtime.GOOS == "windows" {
			os.Rename(backupPath, currentBin)
		}
		u.setError("替换程序失败: %v", err)
		return
	}
	os.Chmod(currentBin, 0755)
	u.log("✅ 程序替换完成")

	// Clean up temp file
	os.Remove(tmpFile)
	os.RemoveAll(tmpDir)

	// Save update popup info
	u.saveUpdatePopup(info)
	u.log("💾 更新信息已保存")

	u.setStatus("restarting", 95, "即将重启 ClawPanel...")
	u.log("🔄 ClawPanel 即将重启，请等待...")

	u.mu.Lock()
	u.progress.Status = "done"
	u.progress.Progress = 100
	u.progress.Message = "更新完成，正在重启..."
	u.progress.FinishedAt = time.Now().Format(time.RFC3339)
	u.mu.Unlock()

	// Restart the service
	go func() {
		time.Sleep(1 * time.Second)
		// Try systemctl first
		if err := execCmd("systemctl", "restart", "clawpanel"); err != nil {
			// Fallback: exit and let systemd restart us
			log.Printf("[Updater] systemctl restart failed: %v, exiting...", err)
			os.Exit(0)
		}
	}()
}

func (u *Updater) downloadFile(url, dest string) error {
	client := &http.Client{Timeout: downloadTimeout}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()

	totalSize := resp.ContentLength
	var downloaded int64
	buf := make([]byte, 32*1024)

	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return werr
			}
			downloaded += int64(n)
			if totalSize > 0 {
				pct := int(float64(downloaded) / float64(totalSize) * 50) + 10 // 10-60%
				u.setStatus("downloading", pct, fmt.Sprintf("正在下载... %.1f MB / %.1f MB", float64(downloaded)/1048576, float64(totalSize)/1048576))
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}

	return nil
}

func (u *Updater) saveUpdatePopup(info *UpdateInfo) {
	popup := UpdatePopup{
		Show:        true,
		Version:     info.LatestVersion,
		ReleaseNote: info.ReleaseNote,
	}
	data, _ := json.MarshalIndent(popup, "", "  ")
	os.WriteFile(filepath.Join(u.dataDir, "update_popup.json"), data, 0644)
}

// GetUpdatePopup reads the popup info
func (u *Updater) GetUpdatePopup() *UpdatePopup {
	data, err := os.ReadFile(filepath.Join(u.dataDir, "update_popup.json"))
	if err != nil {
		return nil
	}
	var popup UpdatePopup
	if err := json.Unmarshal(data, &popup); err != nil {
		return nil
	}
	return &popup
}

// MarkPopupShown marks the popup as shown
func (u *Updater) MarkPopupShown() {
	popup := u.GetUpdatePopup()
	if popup == nil {
		return
	}
	popup.Show = false
	popup.ShownAt = time.Now().Format(time.RFC3339)
	data, _ := json.MarshalIndent(popup, "", "  ")
	os.WriteFile(filepath.Join(u.dataDir, "update_popup.json"), data, 0644)
}

func (u *Updater) log(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	log.Printf("[Updater] %s", msg)
	u.mu.Lock()
	u.progress.Log = append(u.progress.Log, msg)
	u.mu.Unlock()
}

func (u *Updater) setStatus(status string, progress int, message string) {
	u.mu.Lock()
	u.progress.Status = status
	u.progress.Progress = progress
	u.progress.Message = message
	u.mu.Unlock()
}

func (u *Updater) setError(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	log.Printf("[Updater] ERROR: %s", msg)
	u.mu.Lock()
	u.progress.Status = "error"
	u.progress.Error = msg
	u.progress.Message = "更新失败"
	u.progress.Log = append(u.progress.Log, "❌ "+msg)
	u.progress.FinishedAt = time.Now().Format(time.RFC3339)
	u.mu.Unlock()
}

// isNewerVersion compares semver strings like "v5.0.2" > "v5.0.1"
func isNewerVersion(latest, current string) bool {
	latest = strings.TrimPrefix(latest, "v")
	current = strings.TrimPrefix(current, "v")
	lp := strings.Split(latest, ".")
	cp := strings.Split(current, ".")
	for i := 0; i < len(lp) && i < len(cp); i++ {
		lv := 0
		cv := 0
		fmt.Sscanf(lp[i], "%d", &lv)
		fmt.Sscanf(cp[i], "%d", &cv)
		if lv > cv {
			return true
		}
		if lv < cv {
			return false
		}
	}
	return len(lp) > len(cp)
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func execCmd(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	return cmd.Run()
}
