package handler

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zhaoxinyi02/ClawPanel/internal/config"
)

func TestLoadSkillHubCatalogDoesNotPoisonLastGoodURLWhenDiscoveredURLFails(t *testing.T) {
	restore := resetSkillHubTestState(t)
	defer restore()

	badDynamicURL := skillHubCDNBase + "skills.deadbeef.json"
	skillHubHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch req.URL.String() {
		case skillHubHomepage:
			return newHTTPResponse(http.StatusOK, `<script src="/assets/main.js"></script>skills.deadbeef.json`), nil
		case badDynamicURL:
			return newHTTPResponse(http.StatusNotFound, `not found`), nil
		case skillHubBootstrapURL:
			return newHTTPResponse(http.StatusOK, validSkillHubCatalogJSON("bootstrap-skill")), nil
		default:
			return nil, errors.New("unexpected url: " + req.URL.String())
		}
	})}

	catalog, err := loadSkillHubCatalog()
	if err != nil {
		t.Fatalf("loadSkillHubCatalog error: %v", err)
	}
	if catalog == nil || len(catalog.Skills) != 1 || catalog.Skills[0].Slug != "bootstrap-skill" {
		t.Fatalf("expected bootstrap catalog, got %#v", catalog)
	}
	if skillHubLastGoodURL != skillHubBootstrapURL {
		t.Fatalf("expected lastGoodURL %q, got %q", skillHubBootstrapURL, skillHubLastGoodURL)
	}
}

func TestLoadSkillHubCatalogReturnsStaleCacheWhenRefreshFails(t *testing.T) {
	restore := resetSkillHubTestState(t)
	defer restore()

	stale := &skillHubCatalog{
		Total:       1,
		GeneratedAt: "2026-03-01T13:44:23Z",
		Featured:    []string{"cached-skill"},
		Categories:  map[string][]string{"AI 智能": {"ai"}},
		Skills:      []skillHubSkillItem{{Slug: "cached-skill", Name: "Cached Skill"}},
	}
	skillHubCache = stale
	skillHubCacheTime = time.Now().Add(-2 * skillHubCacheTTL)
	skillHubLastGoodURL = skillHubCDNBase + "skills.cached.json"

	skillHubHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch req.URL.String() {
		case skillHubHomepage:
			return nil, errors.New("homepage unavailable")
		case skillHubLastGoodURL, skillHubBootstrapURL:
			return nil, errors.New("upstream unavailable")
		default:
			return nil, errors.New("unexpected url: " + req.URL.String())
		}
	})}

	got, err := loadSkillHubCatalog()
	if err != nil {
		t.Fatalf("expected stale cache fallback, got error: %v", err)
	}
	if got != stale {
		t.Fatalf("expected stale cache pointer, got %#v", got)
	}
}

func TestLoadSkillHubCatalogErrorsWithoutAnySuccessfulCatalog(t *testing.T) {
	restore := resetSkillHubTestState(t)
	defer restore()

	skillHubHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch req.URL.String() {
		case skillHubHomepage:
			return nil, errors.New("homepage unavailable")
		case skillHubBootstrapURL:
			return nil, errors.New("bootstrap unavailable")
		default:
			return nil, errors.New("unexpected url: " + req.URL.String())
		}
	})}

	if _, err := loadSkillHubCatalog(); err == nil {
		t.Fatalf("expected error when no cache and upstream unavailable")
	}
}

func TestLoadSkillHubCatalogSkipsRefreshDuringRetryBackoff(t *testing.T) {
	restore := resetSkillHubTestState(t)
	defer restore()

	stale := &skillHubCatalog{
		Total:       1,
		GeneratedAt: "2026-03-01T13:44:23Z",
		Featured:    []string{"cached-skill"},
		Categories:  map[string][]string{"AI 智能": {"ai"}},
		Skills:      []skillHubSkillItem{{Slug: "cached-skill", Name: "Cached Skill"}},
	}
	skillHubCache = stale
	skillHubCacheTime = time.Now().Add(-2 * skillHubCacheTTL)
	skillHubNextRetryTime = time.Now().Add(2 * time.Minute)

	calls := 0
	skillHubHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("network should not be used during retry backoff")
	})}

	got, err := loadSkillHubCatalog()
	if err != nil {
		t.Fatalf("expected stale cache during retry backoff, got error: %v", err)
	}
	if got != stale {
		t.Fatalf("expected stale cache pointer, got %#v", got)
	}
	if calls != 0 {
		t.Fatalf("expected no upstream calls during retry backoff, got %d", calls)
	}
}

func TestLoadSkillHubCatalogRetriesWithoutCacheEvenIfRetryWindowIsSet(t *testing.T) {
	restore := resetSkillHubTestState(t)
	defer restore()

	skillHubNextRetryTime = time.Now().Add(2 * time.Minute)
	skillHubLastErr = "temporary failure"

	calls := 0
	skillHubHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		switch req.URL.String() {
		case skillHubHomepage:
			return nil, errors.New("homepage unavailable")
		case skillHubBootstrapURL:
			return newHTTPResponse(http.StatusOK, validSkillHubCatalogJSON("recovered-skill")), nil
		default:
			return nil, errors.New("unexpected url: " + req.URL.String())
		}
	})}

	got, err := loadSkillHubCatalog()
	if err != nil {
		t.Fatalf("expected successful retry without cache, got error: %v", err)
	}
	if got == nil || len(got.Skills) != 1 || got.Skills[0].Slug != "recovered-skill" {
		t.Fatalf("expected recovered catalog, got %#v", got)
	}
	if calls == 0 {
		t.Fatalf("expected upstream retry when no cache exists")
	}
}

func TestLoadSkillHubCatalogReturnsStaleImmediatelyWhileRefreshInFlight(t *testing.T) {
	restore := resetSkillHubTestState(t)
	defer restore()

	stale := &skillHubCatalog{
		Total:       1,
		GeneratedAt: "2026-03-01T13:44:23Z",
		Featured:    []string{"cached-skill"},
		Categories:  map[string][]string{"AI 智能": {"ai"}},
		Skills:      []skillHubSkillItem{{Slug: "cached-skill", Name: "Cached Skill"}},
	}
	skillHubCache = stale
	skillHubCacheTime = time.Now().Add(-2 * skillHubCacheTTL)

	homepageStarted := make(chan struct{})
	releaseHomepage := make(chan struct{})
	skillHubHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch req.URL.String() {
		case skillHubHomepage:
			select {
			case <-homepageStarted:
			default:
				close(homepageStarted)
			}
			<-releaseHomepage
			return nil, errors.New("homepage unavailable")
		case skillHubBootstrapURL:
			return nil, errors.New("bootstrap unavailable")
		default:
			return nil, errors.New("unexpected url: " + req.URL.String())
		}
	})}

	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = loadSkillHubCatalog()
	}()

	select {
	case <-homepageStarted:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for refresh to start")
	}

	start := time.Now()
	got, err := loadSkillHubCatalog()
	if err != nil {
		t.Fatalf("expected stale cache while refresh in flight, got error: %v", err)
	}
	if got != stale {
		t.Fatalf("expected stale cache pointer, got %#v", got)
	}
	if elapsed := time.Since(start); elapsed > 200*time.Millisecond {
		t.Fatalf("expected stale response without waiting for refresh, took %v", elapsed)
	}

	close(releaseHomepage)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for refresh goroutine to exit")
	}
}

func TestGetSkillHubStatusReportsInstalledBinary(t *testing.T) {
	gin.SetMode(gin.TestMode)
	restore := resetSkillHubTestState(t)
	defer restore()

	root := t.TempDir()
	binPath := filepath.Join(root, "skillhub")
	if err := os.WriteFile(binPath, []byte(`#!/bin/sh
exit 0
`), 0o755); err != nil {
		t.Fatalf("write fake skillhub: %v", err)
	}
	t.Setenv("SKILLHUB_BIN", binPath)
	t.Setenv("PATH", root)
	skillHubBinaryCandidatePaths = nil

	r := gin.New()
	r.GET("/system/skillhub/status", GetSkillHubStatus(&config.Config{}))
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/system/skillhub/status", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		OK        bool   `json:"ok"`
		Installed bool   `json:"installed"`
		BinPath   string `json:"binPath"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !resp.OK || !resp.Installed || resp.BinPath != binPath {
		t.Fatalf("unexpected status response: %+v", resp)
	}
}

func TestInstallSkillHubCLIInstallsFromOfficialKit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	restore := resetSkillHubTestState(t)
	defer restore()

	root := t.TempDir()
	home := filepath.Join(root, "home")
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("create bin dir: %v", err)
	}
	linkSystemCommands(t, binDir, "bash", "mkdir", "chmod", "cat")
	t.Setenv("HOME", home)
	t.Setenv("PATH", binDir)
	skillHubBinaryCandidatePaths = nil

	archiveBytes := buildSkillHubInstallArchive(t, "bundle/cli/install.sh", `#!/bin/sh
set -eu
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/skillhub" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$HOME/.local/bin/skillhub"
printf 'installed cli'
`)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/latest.tar.gz" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(archiveBytes)
	}))
	defer server.Close()
	skillHubInstallKitURL = server.URL + "/latest.tar.gz"
	skillHubInstallHTTPClient = server.Client()

	r := gin.New()
	r.POST("/system/skillhub/install-cli", InstallSkillHubCLI(&config.Config{}))
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/system/skillhub/install-cli", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		OK        bool   `json:"ok"`
		Installed bool   `json:"installed"`
		BinPath   string `json:"binPath"`
		Output    string `json:"output"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !resp.OK || !resp.Installed {
		t.Fatalf("unexpected response: %+v", resp)
	}
	if filepath.Base(resp.BinPath) != "skillhub" {
		t.Fatalf("expected skillhub binary path, got %q", resp.BinPath)
	}
	if _, err := os.Stat(filepath.Join(home, ".local", "bin", "skillhub")); err != nil {
		t.Fatalf("expected installed binary: %v", err)
	}
	if !strings.Contains(resp.Output, "installed cli") {
		t.Fatalf("expected installer output, got %q", resp.Output)
	}
}

func TestInstallSkillHubSkillRunsCommandInSelectedWorkspace(t *testing.T) {
	gin.SetMode(gin.TestMode)
	restore := resetSkillHubTestState(t)
	defer restore()

	root := resolvedTempDir(t)
	workspace := filepath.Join(root, "workspace")
	openClawDir := filepath.Join(root, "openclaw")
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("create bin dir: %v", err)
	}
	linkSystemCommands(t, binDir, "mkdir")
	cfg := &config.Config{OpenClawDir: openClawDir, OpenClawWork: workspace}
	logPath := filepath.Join(root, "skillhub-call.log")
	binPath := filepath.Join(root, "skillhub")
	script := `#!/bin/sh
set -eu
printf 'pwd=%s\n' "$PWD" > "` + logPath + `"
printf 'args=%s %s\n' "$1" "$2" >> "` + logPath + `"
mkdir -p "$PWD/skills/$2"
printf 'installed %s' "$2"
`
	if err := os.WriteFile(binPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake skillhub: %v", err)
	}
	t.Setenv("SKILLHUB_BIN", binPath)
	t.Setenv("PATH", binDir)
	skillHubBinaryCandidatePaths = nil

	r := gin.New()
	r.POST("/system/skillhub/install", InstallSkillHubSkill(cfg))
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/system/skillhub/install", strings.NewReader(`{"skillId":"demo-skill","agentId":"main"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"skillId":"demo-skill"`) {
		t.Fatalf("expected installed skill response, got %s", body)
	}
	logged, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read skillhub log: %v", err)
	}
	logText := string(logged)
	if !strings.Contains(logText, "pwd="+workspace) {
		t.Fatalf("expected workspace cwd, got %q", logText)
	}
	if !strings.Contains(logText, "args=install demo-skill") {
		t.Fatalf("expected install args, got %q", logText)
	}
}

func resetSkillHubTestState(t *testing.T) func() {
	t.Helper()
	origClient := skillHubHTTPClient
	origCache := skillHubCache
	origCacheTime := skillHubCacheTime
	origLastGood := skillHubLastGoodURL
	origNextRetry := skillHubNextRetryTime
	origLastErr := skillHubLastErr
	origRefreshInFlight := skillHubRefreshInFlight
	origRefreshDone := skillHubRefreshDone
	origInstallClient := skillHubInstallHTTPClient
	origInstallKitURL := skillHubInstallKitURL
	origBinaryCandidates := append([]string(nil), skillHubBinaryCandidatePaths...)

	skillHubCache = nil
	skillHubCacheTime = time.Time{}
	skillHubLastGoodURL = ""
	skillHubNextRetryTime = time.Time{}
	skillHubLastErr = ""
	skillHubRefreshInFlight = false
	skillHubRefreshDone = nil
	skillHubInstallHTTPClient = &http.Client{Timeout: skillHubInstallTimeout}
	skillHubInstallKitURL = skillHubDefaultInstallKit
	skillHubBinaryCandidatePaths = []string{"/usr/local/bin/skillhub", "/opt/homebrew/bin/skillhub"}

	return func() {
		skillHubHTTPClient = origClient
		skillHubCache = origCache
		skillHubCacheTime = origCacheTime
		skillHubLastGoodURL = origLastGood
		skillHubNextRetryTime = origNextRetry
		skillHubLastErr = origLastErr
		skillHubRefreshInFlight = origRefreshInFlight
		skillHubRefreshDone = origRefreshDone
		skillHubInstallHTTPClient = origInstallClient
		skillHubInstallKitURL = origInstallKitURL
		skillHubBinaryCandidatePaths = origBinaryCandidates
	}
}

func newHTTPResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}

func validSkillHubCatalogJSON(slug string) string {
	return `{"total":1,"generated_at":"2026-03-01T13:44:23Z","featured":["` + slug + `"],"categories":{"AI 智能":["ai"]},"skills":[{"slug":"` + slug + `","name":"` + slug + `","description":"desc","description_zh":"描述","version":"1.0.0","homepage":"https://clawhub.ai/skills/` + slug + `","tags":["ai"],"downloads":1,"stars":1,"installs":1,"updated_at":1772065840450,"score":1.2,"owner":"clawhub"}]}`
}

func buildSkillHubInstallArchive(t *testing.T, installerPath string, installerContent string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tarWriter := tar.NewWriter(gz)
	entries := []struct {
		name string
		body string
		mode int64
	}{
		{name: filepath.Dir(installerPath), mode: 0o755},
		{name: installerPath, body: installerContent, mode: 0o755},
	}
	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Mode: entry.mode}
		if entry.body == "" {
			header.Typeflag = tar.TypeDir
		} else {
			header.Typeflag = tar.TypeReg
			header.Size = int64(len(entry.body))
		}
		if err := tarWriter.WriteHeader(header); err != nil {
			t.Fatalf("write tar header: %v", err)
		}
		if entry.body != "" {
			if _, err := tarWriter.Write([]byte(entry.body)); err != nil {
				t.Fatalf("write tar body: %v", err)
			}
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatalf("close tar writer: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close gzip writer: %v", err)
	}
	return buf.Bytes()
}

func linkSystemCommands(t *testing.T, targetDir string, names ...string) {
	t.Helper()
	for _, name := range names {
		path, err := exec.LookPath(name)
		if err != nil {
			t.Fatalf("look up %s: %v", name, err)
		}
		if err := os.Symlink(path, filepath.Join(targetDir, name)); err != nil {
			t.Fatalf("symlink %s: %v", name, err)
		}
	}
}
