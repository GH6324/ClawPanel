package handler

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zhaoxinyi02/ClawPanel/internal/config"
)

// --- S1: Types + Cache ---

type skillHubCatalog struct {
	Total       int                 `json:"total"`
	GeneratedAt string              `json:"generated_at"`
	Featured    []string            `json:"featured"`
	Categories  map[string][]string `json:"categories"`
	Skills      []skillHubSkillItem `json:"skills"`
}

type skillHubSkillItem struct {
	Slug          string   `json:"slug"`
	Name          string   `json:"name"`
	Description   string   `json:"description"`
	DescriptionZh string   `json:"description_zh"`
	Version       string   `json:"version"`
	Homepage      string   `json:"homepage"`
	Tags          []string `json:"tags"`
	Downloads     int      `json:"downloads"`
	Stars         int      `json:"stars"`
	Installs      int      `json:"installs"`
	UpdatedAt     int64    `json:"updated_at"`
	Score         float64  `json:"score"`
	Owner         string   `json:"owner"`
}

// trimmed item for API response (keep homepage so UI can link to a real detail page)
type skillHubSkillTrimmed struct {
	Slug          string   `json:"slug"`
	Name          string   `json:"name"`
	Description   string   `json:"description"`
	DescriptionZh string   `json:"description_zh"`
	Version       string   `json:"version"`
	Homepage      string   `json:"homepage,omitempty"`
	Tags          []string `json:"tags"`
	Downloads     int      `json:"downloads"`
	Stars         int      `json:"stars"`
	UpdatedAt     int64    `json:"updated_at"`
	Score         float64  `json:"score"`
	Owner         string   `json:"owner"`
}

var (
	skillHubCache           *skillHubCatalog
	skillHubCacheTime       time.Time
	skillHubCacheMu         sync.Mutex
	skillHubLastGoodURL     string
	skillHubNextRetryTime   time.Time
	skillHubLastErr         string
	skillHubRefreshInFlight bool
	skillHubRefreshDone     chan struct{}
)

const (
	skillHubCacheTTL           = 1 * time.Hour
	skillHubBootstrapURL       = "https://cloudcache.tencentcs.com/qcloud/tea/app/data/skills.805f4f80.json"
	skillHubHomepage           = "https://skillhub.tencent.com/"
	skillHubMaxBodyBytes       = 16 << 20 // 16MB
	skillHubFetchTimeout       = 25 * time.Second
	skillHubRetryBackoff       = 5 * time.Minute
	skillHubCDNBase            = "https://cloudcache.tencentcs.com/qcloud/tea/app/data/"
	skillHubDefaultInstallKit  = "https://skillhub-1251783334.cos.ap-guangzhou.myqcloud.com/install/latest.tar.gz"
	skillHubInstallGuideURL    = "https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/skillhub.md"
	skillHubInstallTimeout     = 5 * time.Minute
	skillHubInstallMaxBytes    = 32 << 20 // 32MB
	skillHubCommandOutputLimit = 4096
)

var skillHubJSONHashRe = regexp.MustCompile(`skills\.([0-9a-f]+)\.json`)

var skillHubHTTPClient = &http.Client{Timeout: skillHubFetchTimeout}
var skillHubInstallHTTPClient = &http.Client{Timeout: skillHubInstallTimeout}
var skillHubInstallKitURL = skillHubDefaultInstallKit
var skillHubBinaryCandidatePaths = []string{"/usr/local/bin/skillhub", "/opt/homebrew/bin/skillhub"}

// --- S2: URL Discovery + Handler ---

// discoverSkillHubJSONURL fetches the SkillHub homepage and extracts the
// current JSON data URL from embedded script/asset references.
func discoverSkillHubJSONURL() (string, error) {
	resp, err := skillHubHTTPClient.Get(skillHubHomepage)
	if err != nil {
		return "", fmt.Errorf("fetch skillhub homepage: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("skillhub homepage returned %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024)) // 512KB max for HTML
	if err != nil {
		return "", fmt.Errorf("read skillhub homepage: %w", err)
	}
	matches := skillHubJSONHashRe.FindAllStringSubmatch(string(body), -1)
	if len(matches) == 0 {
		return "", fmt.Errorf("no skills JSON hash found in homepage")
	}
	// use the last match (usually in main JS bundle near bottom)
	filename := matches[len(matches)-1][0]
	return skillHubCDNBase + filename, nil
}

// resolveSkillHubJSONURLs returns candidate URLs in priority order without
// mutating the last-good state. lastGoodURL is only updated after a successful
// JSON fetch and decode.
func resolveSkillHubJSONURLs(lastGoodURL string) []string {
	urls := make([]string, 0, 3)
	seen := make(map[string]struct{}, 3)
	appendURL := func(url string) {
		if url == "" {
			return
		}
		if _, ok := seen[url]; ok {
			return
		}
		seen[url] = struct{}{}
		urls = append(urls, url)
	}
	url, err := discoverSkillHubJSONURL()
	if err == nil && url != "" {
		appendURL(url)
	}
	appendURL(lastGoodURL)
	appendURL(skillHubBootstrapURL)
	return urls
}

func fetchSkillHubCatalog(url string) (*skillHubCatalog, error) {
	resp, err := skillHubHTTPClient.Get(url)
	if err != nil {
		return nil, fmt.Errorf("fetch skillhub JSON: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("skillhub JSON returned %d", resp.StatusCode)
	}

	reader := io.LimitReader(resp.Body, skillHubMaxBodyBytes)
	var catalog skillHubCatalog
	dec := json.NewDecoder(reader)
	if err := dec.Decode(&catalog); err != nil {
		return nil, fmt.Errorf("parse skillhub JSON: %w", err)
	}
	if catalog.Skills == nil {
		return nil, fmt.Errorf("skillhub JSON missing skills list")
	}
	if catalog.Featured == nil {
		catalog.Featured = []string{}
	}
	if catalog.Categories == nil {
		catalog.Categories = map[string][]string{}
	}
	return &catalog, nil
}

func refreshSkillHubCatalog(lastGoodURL string) (*skillHubCatalog, string, error) {
	var lastErr error
	for _, jsonURL := range resolveSkillHubJSONURLs(lastGoodURL) {
		catalog, err := fetchSkillHubCatalog(jsonURL)
		if err != nil {
			lastErr = err
			continue
		}
		return catalog, jsonURL, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("failed to resolve skillhub catalog URL")
	}
	return nil, "", lastErr
}

func loadSkillHubCatalog() (*skillHubCatalog, error) {
	for {
		now := time.Now()

		skillHubCacheMu.Lock()
		if skillHubCache != nil && now.Sub(skillHubCacheTime) < skillHubCacheTTL {
			cached := skillHubCache
			skillHubCacheMu.Unlock()
			return cached, nil
		}
		if skillHubCache != nil && !skillHubNextRetryTime.IsZero() && now.Before(skillHubNextRetryTime) {
			cached := skillHubCache
			skillHubCacheMu.Unlock()
			return cached, nil
		}
		if skillHubRefreshInFlight {
			waitCh := skillHubRefreshDone
			cached := skillHubCache
			skillHubCacheMu.Unlock()

			if cached != nil {
				return cached, nil
			}
			if waitCh != nil {
				<-waitCh
			}

			skillHubCacheMu.Lock()
			cached = skillHubCache
			lastErr := skillHubLastErr
			skillHubCacheMu.Unlock()
			if cached != nil {
				return cached, nil
			}
			if lastErr != "" {
				return nil, fmt.Errorf("%s", lastErr)
			}
			continue
		}

		staleCache := skillHubCache
		lastGoodURL := skillHubLastGoodURL
		doneCh := make(chan struct{})
		skillHubRefreshInFlight = true
		skillHubRefreshDone = doneCh
		skillHubCacheMu.Unlock()

		catalog, jsonURL, err := refreshSkillHubCatalog(lastGoodURL)

		skillHubCacheMu.Lock()
		skillHubRefreshInFlight = false
		close(doneCh)
		skillHubRefreshDone = nil

		if err == nil {
			skillHubLastGoodURL = jsonURL
			skillHubCache = catalog
			skillHubCacheTime = time.Now()
			skillHubNextRetryTime = time.Time{}
			skillHubLastErr = ""
			skillHubCacheMu.Unlock()
			return catalog, nil
		}

		skillHubLastErr = err.Error()
		if staleCache != nil {
			skillHubNextRetryTime = time.Now().Add(skillHubRetryBackoff)
			cached := skillHubCache
			if cached == nil {
				cached = staleCache
			}
			skillHubCacheMu.Unlock()
			return cached, nil
		}
		skillHubNextRetryTime = time.Time{}
		skillHubCacheMu.Unlock()
		return nil, err
	}
}

func trimSkillHubSkills(skills []skillHubSkillItem) []skillHubSkillTrimmed {
	out := make([]skillHubSkillTrimmed, len(skills))
	for i, s := range skills {
		out[i] = skillHubSkillTrimmed{
			Slug:          s.Slug,
			Name:          s.Name,
			Description:   s.Description,
			DescriptionZh: s.DescriptionZh,
			Version:       s.Version,
			Homepage:      strings.TrimSpace(s.Homepage),
			Tags:          s.Tags,
			Downloads:     s.Downloads,
			Stars:         s.Stars,
			UpdatedAt:     s.UpdatedAt,
			Score:         s.Score,
			Owner:         s.Owner,
		}
	}
	return out
}

// GetSkillHubCatalog returns the SkillHub catalog data.
func GetSkillHubCatalog(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		catalog, err := loadSkillHubCatalog()
		if err != nil {
			errMsg := err.Error()
			// sanitize internal URLs from error message
			if strings.Contains(errMsg, "cloudcache.tencentcs.com") {
				errMsg = "failed to load SkillHub data from upstream"
			}
			c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": errMsg})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"ok":          true,
			"total":       catalog.Total,
			"generatedAt": catalog.GeneratedAt,
			"featured":    catalog.Featured,
			"categories":  catalog.Categories,
			"skills":      trimSkillHubSkills(catalog.Skills),
		})
	}
}

// GetSkillHubStatus reports whether the official SkillHub CLI is available locally.
func GetSkillHubStatus(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		binPath, err := resolveSkillHubBinary()
		resp := gin.H{
			"ok":                  true,
			"installed":           err == nil,
			"installGuideURL":     skillHubInstallGuideURL,
			"skillInstallCommand": "skillhub install <slug>",
		}
		if err == nil {
			resp["binPath"] = binPath
		} else {
			resp["error"] = err.Error()
		}
		c.JSON(http.StatusOK, resp)
	}
}

// InstallSkillHubCLI installs the official SkillHub CLI from Tencent's published kit.
func InstallSkillHubCLI(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		if binPath, err := resolveSkillHubBinary(); err == nil {
			c.JSON(http.StatusOK, gin.H{"ok": true, "installed": true, "binPath": binPath})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), skillHubInstallTimeout)
		defer cancel()

		binPath, output, err := installSkillHubCLI(ctx)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": err.Error(), "output": output})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "installed": true, "binPath": binPath, "output": output})
	}
}

// InstallSkillHubSkill runs the official `skillhub install <slug>` command inside the selected workspace.
func InstallSkillHubSkill(cfg *config.Config) gin.HandlerFunc {
	type reqBody struct {
		SkillID string `json:"skillId"`
		AgentID string `json:"agentId"`
	}
	return func(c *gin.Context) {
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
			return
		}
		slug := sanitizeClawHubSlug(req.SkillID)
		if slug == "" {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid skillId"})
			return
		}
		agentID, err := resolveRequestedAgentID(cfg, req.AgentID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
			return
		}
		workdir := resolveSkillsWorkspace(cfg, agentID)
		if workdir == "" {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "workspace not configured"})
			return
		}
		if err := ensureClawHubStatePath(workdir); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
			return
		}
		if err := os.MkdirAll(filepath.Join(workdir, "skills"), 0o755); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": fmt.Sprintf("create workspace directories: %v", err)})
			return
		}
		binPath, err := resolveSkillHubBinary()
		if err != nil {
			c.JSON(http.StatusPreconditionFailed, gin.H{"ok": false, "error": err.Error(), "needsCLI": true})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), skillHubInstallTimeout)
		defer cancel()

		output, err := runCommandCapture(ctx, workdir, binPath, "install", slug)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": wrapSkillHubCommandError("skillhub install", err, output).Error(), "output": output})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "agentId": agentID, "skillId": slug, "output": output})
	}
}

func resolveSkillHubBinary() (string, error) {
	seen := make(map[string]struct{}, 8)
	candidates := make([]string, 0, 8)
	if envPath := strings.TrimSpace(os.Getenv("SKILLHUB_BIN")); envPath != "" {
		candidates = append(candidates, envPath)
	}
	candidates = append(candidates, "skillhub")
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		candidates = append(candidates,
			filepath.Join(home, ".local", "bin", "skillhub"),
			filepath.Join(home, "bin", "skillhub"),
		)
	}
	candidates = append(candidates, skillHubBinaryCandidatePaths...)

	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if _, ok := seen[candidate]; ok {
			continue
		}
		seen[candidate] = struct{}{}

		if filepath.Base(candidate) == candidate && !strings.Contains(candidate, string(os.PathSeparator)) {
			if resolved, err := exec.LookPath(candidate); err == nil {
				return resolved, nil
			}
			continue
		}

		info, err := os.Stat(candidate)
		if err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("SkillHub CLI not found; install SkillHub CLI first")
}

func installSkillHubCLI(ctx context.Context) (string, string, error) {
	tempDir, err := os.MkdirTemp("", "clawpanel-skillhub-install-*")
	if err != nil {
		return "", "", fmt.Errorf("create temporary installer workspace: %w", err)
	}
	defer os.RemoveAll(tempDir)

	archivePath := filepath.Join(tempDir, "skillhub-latest.tar.gz")
	if err := downloadSkillHubInstallKit(ctx, archivePath); err != nil {
		return "", "", err
	}
	installerPath, err := extractSkillHubInstallKit(tempDir, archivePath)
	if err != nil {
		return "", "", err
	}
	output, err := runCommandCapture(ctx, filepath.Dir(installerPath), "bash", installerPath)
	if err != nil {
		return "", output, wrapSkillHubCommandError("install SkillHub CLI", err, output)
	}
	binPath, err := resolveSkillHubBinary()
	if err != nil {
		return "", output, err
	}
	return binPath, output, nil
}

func downloadSkillHubInstallKit(ctx context.Context, targetPath string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, skillHubInstallKitURL, nil)
	if err != nil {
		return fmt.Errorf("create SkillHub installer request: %w", err)
	}
	resp, err := skillHubInstallHTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("download SkillHub installer: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("SkillHub installer returned %d", resp.StatusCode)
	}
	file, err := os.Create(targetPath)
	if err != nil {
		return fmt.Errorf("create installer archive: %w", err)
	}
	defer file.Close()

	written, err := io.Copy(file, io.LimitReader(resp.Body, skillHubInstallMaxBytes+1))
	if err != nil {
		return fmt.Errorf("write installer archive: %w", err)
	}
	if written > skillHubInstallMaxBytes {
		return fmt.Errorf("SkillHub installer archive is too large")
	}
	return nil
}

func extractSkillHubInstallKit(rootDir, archivePath string) (string, error) {
	archiveFile, err := os.Open(archivePath)
	if err != nil {
		return "", fmt.Errorf("open installer archive: %w", err)
	}
	defer archiveFile.Close()

	gzReader, err := gzip.NewReader(archiveFile)
	if err != nil {
		return "", fmt.Errorf("read installer gzip: %w", err)
	}
	defer gzReader.Close()

	tarReader := tar.NewReader(gzReader)
	rootPrefix := rootDir + string(os.PathSeparator)
	var installerPath string

	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("read installer archive: %w", err)
		}

		relPath := filepath.Clean(header.Name)
		if relPath == "." || relPath == "" || relPath == string(os.PathSeparator) {
			continue
		}
		if strings.HasPrefix(relPath, "..") || filepath.IsAbs(relPath) {
			return "", fmt.Errorf("installer archive contains invalid path %q", header.Name)
		}

		targetPath := filepath.Join(rootDir, relPath)
		if targetPath != rootDir && !strings.HasPrefix(targetPath, rootPrefix) {
			return "", fmt.Errorf("installer archive escapes destination")
		}

		switch header.Typeflag {
		case tar.TypeDir:
			mode := os.FileMode(header.Mode)
			if mode == 0 {
				mode = 0o755
			}
			if err := os.MkdirAll(targetPath, mode); err != nil {
				return "", fmt.Errorf("create installer directory: %w", err)
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
				return "", fmt.Errorf("create installer file parent: %w", err)
			}
			mode := os.FileMode(header.Mode)
			if mode == 0 {
				mode = 0o644
			}
			file, err := os.OpenFile(targetPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				return "", fmt.Errorf("create installer file: %w", err)
			}
			if _, err := io.Copy(file, tarReader); err != nil {
				file.Close()
				return "", fmt.Errorf("extract installer file: %w", err)
			}
			if err := file.Close(); err != nil {
				return "", fmt.Errorf("close installer file: %w", err)
			}
			unixPath := filepath.ToSlash(relPath)
			if unixPath == "cli/install.sh" || strings.HasSuffix(unixPath, "/cli/install.sh") {
				installerPath = targetPath
			}
		case tar.TypeSymlink, tar.TypeLink:
			return "", fmt.Errorf("installer archive contains unsupported linked file %q", header.Name)
		default:
			return "", fmt.Errorf("installer archive contains unsupported entry %q", header.Name)
		}
	}

	if installerPath == "" {
		return "", fmt.Errorf("SkillHub installer archive missing cli/install.sh")
	}
	return installerPath, nil
}

func runCommandCapture(ctx context.Context, dir, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = os.Environ()
	output, err := cmd.CombinedOutput()
	return trimSkillHubCommandOutput(output), err
}

func trimSkillHubCommandOutput(output []byte) string {
	trimmed := strings.TrimSpace(string(output))
	if len(trimmed) <= skillHubCommandOutputLimit {
		return trimmed
	}
	return trimmed[:skillHubCommandOutputLimit] + "..."
}

func wrapSkillHubCommandError(action string, err error, output string) error {
	output = strings.TrimSpace(output)
	if output == "" {
		return fmt.Errorf("%s: %w", action, err)
	}
	return fmt.Errorf("%s: %w: %s", action, err, output)
}
