package plugin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/zhaoxinyi02/ClawPanel/internal/config"
)

func TestResolvePluginInstallStrategyPrefersRegistryNpmOverGit(t *testing.T) {
	t.Parallel()

	strategy := resolvePluginInstallStrategy(&RegistryPlugin{
		GitURL:     "https://github.com/example/repo.git",
		NpmPackage: "@openclaw/wecom",
	}, "")

	if strategy.kind != "npm" || strategy.target != "@openclaw/wecom" {
		t.Fatalf("expected npm strategy, got %#v", strategy)
	}
}

func TestResolvePluginInstallStrategyUsesExplicitNpmSource(t *testing.T) {
	t.Parallel()

	strategy := resolvePluginInstallStrategy(&RegistryPlugin{
		GitURL:     "https://github.com/example/repo.git",
		NpmPackage: "@openclaw/wecom",
	}, "@openclaw/custom")

	if strategy.kind != "npm" || strategy.target != "@openclaw/custom" {
		t.Fatalf("expected explicit npm strategy, got %#v", strategy)
	}
}

func TestNormalizeOpenClawInstallSource(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"npm":      "npm",
		"archive":  "archive",
		"path":     "path",
		"local":    "path",
		"registry": "path",
		"custom":   "path",
		"github":   "path",
		"git":      "path",
		"":         "path",
	}

	for input, want := range tests {
		if got := normalizeOpenClawInstallSource(input); got != want {
			t.Fatalf("normalizeOpenClawInstallSource(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestSyncOpenClawPluginStateWritesEntriesAndInstalls(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	cfg := &config.Config{OpenClawDir: dir}
	m := &Manager{cfg: cfg}

	if err := m.syncOpenClawPluginState("dingtalk", dir+"/extensions/dingtalk", true, "registry", "0.2.0"); err != nil {
		t.Fatalf("syncOpenClawPluginState: %v", err)
	}

	saved, err := cfg.ReadOpenClawJSON()
	if err != nil {
		t.Fatalf("ReadOpenClawJSON: %v", err)
	}
	pl, _ := saved["plugins"].(map[string]interface{})
	ent, _ := pl["entries"].(map[string]interface{})
	ins, _ := pl["installs"].(map[string]interface{})
	entry, _ := ent["dingtalk"].(map[string]interface{})
	install, _ := ins["dingtalk"].(map[string]interface{})
	if enabled, _ := entry["enabled"].(bool); !enabled {
		t.Fatalf("expected dingtalk entry enabled, got %#v", entry)
	}
	if got, _ := install["installPath"].(string); got == "" {
		t.Fatalf("expected installPath, got %#v", install)
	}
	if got, _ := install["version"].(string); got != "0.2.0" {
		t.Fatalf("expected version 0.2.0, got %#v", install)
	}
}

func TestRemoveOpenClawPluginStateDeletesEntriesAndInstalls(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	cfg := &config.Config{OpenClawDir: dir}
	m := &Manager{cfg: cfg}
	if err := m.syncOpenClawPluginState("wecom", dir+"/extensions/wecom", true, "registry", "latest"); err != nil {
		t.Fatalf("seed syncOpenClawPluginState: %v", err)
	}
	if err := m.removeOpenClawPluginState("wecom", true); err != nil {
		t.Fatalf("removeOpenClawPluginState: %v", err)
	}
	saved, err := cfg.ReadOpenClawJSON()
	if err != nil {
		t.Fatalf("ReadOpenClawJSON: %v", err)
	}
	pl, _ := saved["plugins"].(map[string]interface{})
	ent, _ := pl["entries"].(map[string]interface{})
	ins, _ := pl["installs"].(map[string]interface{})
	if _, ok := ent["wecom"]; ok {
		t.Fatalf("expected wecom entry removed")
	}
	if _, ok := ins["wecom"]; ok {
		t.Fatalf("expected wecom install removed")
	}
}

// ---------------------------------------------------------------------------
// Gap-fix tests added for multi-dev alignment
// ---------------------------------------------------------------------------

// TestReadPluginMetaFallsBackToOpenClawPluginJSON verifies that when plugin.json
// is absent, readPluginMeta reads metadata from openclaw.plugin.json (official
// manifest format) so ClawPanel-installed plugins remain discoverable by the
// OpenClaw runtime.
func TestReadPluginMetaFallsBackToOpenClawPluginJSON(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	pluginDir := filepath.Join(dir, "myplugin")
	if err := os.MkdirAll(pluginDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	// Write only openclaw.plugin.json – no plugin.json.
	manifest := map[string]interface{}{
		"id":          "myplugin",
		"name":        "My Plugin",
		"version":     "1.2.3",
		"description": "Official manifest format",
	}
	data, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(pluginDir, "openclaw.plugin.json"), data, 0644); err != nil {
		t.Fatalf("write openclaw.plugin.json: %v", err)
	}

	m := &Manager{cfg: &config.Config{OpenClawDir: dir}}
	meta, err := m.readPluginMeta(pluginDir)
	if err != nil {
		t.Fatalf("readPluginMeta: %v", err)
	}
	if meta.ID != "myplugin" {
		t.Fatalf("expected id=myplugin, got %q", meta.ID)
	}
	if meta.Name != "My Plugin" {
		t.Fatalf("expected name=My Plugin, got %q", meta.Name)
	}
	if meta.Version != "1.2.3" {
		t.Fatalf("expected version=1.2.3, got %q", meta.Version)
	}
}

// TestReadPluginMetaPrefersPriorityOrder verifies the fallback priority:
// plugin.json is preferred over openclaw.plugin.json.
func TestReadPluginMetaPrefersPriorityOrder(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	pluginDir := filepath.Join(dir, "dual")
	if err := os.MkdirAll(pluginDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	writeJSON := func(name string, v interface{}) {
		data, _ := json.Marshal(v)
		if err := os.WriteFile(filepath.Join(pluginDir, name), data, 0644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	writeJSON("plugin.json", map[string]interface{}{"id": "dual", "name": "Via plugin.json", "version": "1.0.0"})
	writeJSON("openclaw.plugin.json", map[string]interface{}{"id": "dual", "name": "Via openclaw.plugin.json", "version": "2.0.0"})

	m := &Manager{cfg: &config.Config{OpenClawDir: dir}}
	meta, err := m.readPluginMeta(pluginDir)
	if err != nil {
		t.Fatalf("readPluginMeta: %v", err)
	}
	if meta.Name != "Via plugin.json" {
		t.Fatalf("expected plugin.json to take priority, got name=%q", meta.Name)
	}
}

// TestReadPluginMetaNoMetaFilesError verifies that readPluginMeta returns an
// error when neither plugin.json, openclaw.plugin.json, nor package.json exist.
func TestReadPluginMetaNoMetaFilesError(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	pluginDir := filepath.Join(dir, "empty-plugin")
	if err := os.MkdirAll(pluginDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	m := &Manager{cfg: &config.Config{OpenClawDir: dir}}
	if _, err := m.readPluginMeta(pluginDir); err == nil {
		t.Fatalf("expected error when no metadata files present, got nil")
	}
}

// TestListInstalledReconcilesEnabledFromOpenClawJSON verifies that ListInstalled
// reflects enabled-state changes made to openclaw.json (e.g. via the CLI) even
// when the in-memory plugin map has a stale value.
func TestListInstalledReconcilesEnabledFromOpenClawJSON(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	cfg := &config.Config{OpenClawDir: dir}

	// Seed openclaw.json with the plugin disabled.
	ocConfig := map[string]interface{}{
		"plugins": map[string]interface{}{
			"entries": map[string]interface{}{
				"feishu": map[string]interface{}{"enabled": false},
			},
		},
	}
	data, _ := json.MarshalIndent(ocConfig, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "openclaw.json"), data, 0644); err != nil {
		t.Fatalf("write openclaw.json: %v", err)
	}

	// Build manager with stale in-memory state (enabled=true).
	m := &Manager{
		cfg: cfg,
		plugins: map[string]*InstalledPlugin{
			"feishu": {
				PluginMeta: PluginMeta{ID: "feishu", Name: "Feishu"},
				Enabled:    true, // stale – openclaw.json says false
				Source:     "npm",
				Dir:        filepath.Join(dir, "extensions", "feishu"),
			},
		},
	}

	listed := m.ListInstalled()
	if len(listed) != 1 {
		t.Fatalf("expected 1 plugin, got %d", len(listed))
	}
	if listed[0].Enabled {
		t.Fatalf("expected enabled=false after reconciliation with openclaw.json, got true")
	}
	// The in-memory map must be unchanged – reconciliation returns copies only.
	m.mu.RLock()
	inMemEnabled := m.plugins["feishu"].Enabled
	m.mu.RUnlock()
	if !inMemEnabled {
		t.Fatalf("expected in-memory plugin map to be unmodified (Enabled should still be true)")
	}
}

// TestListInstalledReconcilesEnabledToTrue verifies that if openclaw.json has
// enabled=true but the in-memory state is false, ListInstalled returns true.
func TestListInstalledReconcilesEnabledToTrue(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	cfg := &config.Config{OpenClawDir: dir}

	ocConfig := map[string]interface{}{
		"plugins": map[string]interface{}{
			"entries": map[string]interface{}{
				"discord": map[string]interface{}{"enabled": true},
			},
		},
	}
	data, _ := json.MarshalIndent(ocConfig, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "openclaw.json"), data, 0644); err != nil {
		t.Fatalf("write openclaw.json: %v", err)
	}

	m := &Manager{
		cfg: cfg,
		plugins: map[string]*InstalledPlugin{
			"discord": {
				PluginMeta: PluginMeta{ID: "discord", Name: "Discord"},
				Enabled:    false, // stale
				Source:     "npm",
			},
		},
	}

	listed := m.ListInstalled()
	if len(listed) != 1 || !listed[0].Enabled {
		t.Fatalf("expected enabled=true from openclaw.json reconciliation, got %v", listed)
	}
}

func TestEnsureOpenClawPluginManifestCreatesCompatFile(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	pluginDir := filepath.Join(dir, "compat-plugin")
	if err := os.MkdirAll(pluginDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	meta := &PluginMeta{
		ID:          "compat-plugin",
		Name:        "Compat Plugin",
		Version:     "1.0.0",
		Description: "Generated compatibility manifest",
	}
	m := &Manager{cfg: &config.Config{OpenClawDir: dir}}
	if err := m.ensureOpenClawPluginManifest(pluginDir, meta); err != nil {
		t.Fatalf("ensureOpenClawPluginManifest: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(pluginDir, "openclaw.plugin.json"))
	if err != nil {
		t.Fatalf("read openclaw.plugin.json: %v", err)
	}
	var manifest map[string]interface{}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("decode openclaw.plugin.json: %v", err)
	}
	if got := manifest["id"]; got != "compat-plugin" {
		t.Fatalf("expected id compat-plugin, got %#v", got)
	}
	schema, _ := manifest["configSchema"].(map[string]interface{})
	if schema == nil {
		t.Fatalf("expected generated configSchema, got %#v", manifest["configSchema"])
	}
	if got := schema["type"]; got != "object" {
		t.Fatalf("expected generated configSchema.type=object, got %#v", got)
	}
}

func TestScanInstalledPluginsKeepsPluginWhenCompatManifestWriteFails(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission semantics differ on Windows")
	}
	t.Parallel()

	dir := t.TempDir()
	openClawDir := filepath.Join(dir, "openclaw")
	pluginsDir := filepath.Join(dir, "extensions")
	pluginDir := filepath.Join(pluginsDir, "readonly-plugin")
	if err := os.MkdirAll(pluginDir, 0o755); err != nil {
		t.Fatalf("mkdir plugin dir: %v", err)
	}
	data, _ := json.Marshal(map[string]interface{}{
		"id":          "readonly-plugin",
		"name":        "Readonly Plugin",
		"version":     "1.0.0",
		"description": "plugin.json only",
	})
	if err := os.WriteFile(filepath.Join(pluginDir, "plugin.json"), data, 0o644); err != nil {
		t.Fatalf("write plugin.json: %v", err)
	}
	if err := os.Chmod(pluginDir, 0o555); err != nil {
		t.Fatalf("chmod readonly: %v", err)
	}
	defer os.Chmod(pluginDir, 0o755)

	m := &Manager{
		cfg:        &config.Config{OpenClawDir: openClawDir},
		plugins:    map[string]*InstalledPlugin{},
		pluginsDir: pluginsDir,
		configFile: filepath.Join(dir, "plugins.json"),
	}
	m.scanInstalledPlugins()

	if _, ok := m.plugins["readonly-plugin"]; !ok {
		t.Fatalf("expected plugin to stay visible even when compat manifest cannot be written")
	}
}

// TestScanInstalledPluginsIsReadOnly verifies that scanInstalledPlugins does
// not write any files to disk — neither openclaw.plugin.json in the plugin
// directory nor openclaw.json in the config directory.
func TestScanInstalledPluginsIsReadOnly(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	openClawDir := filepath.Join(dir, "openclaw")
	if err := os.MkdirAll(openClawDir, 0o755); err != nil {
		t.Fatalf("mkdir openclaw dir: %v", err)
	}
	pluginsDir := filepath.Join(dir, "extensions")
	pluginDir := filepath.Join(pluginsDir, "test-plugin")
	if err := os.MkdirAll(pluginDir, 0o755); err != nil {
		t.Fatalf("mkdir plugin dir: %v", err)
	}

	data, _ := json.Marshal(map[string]interface{}{
		"id":          "test-plugin",
		"name":        "Test Plugin",
		"version":     "1.0.0",
		"description": "for scan read-only test",
	})
	if err := os.WriteFile(filepath.Join(pluginDir, "plugin.json"), data, 0o644); err != nil {
		t.Fatalf("write plugin.json: %v", err)
	}

	m := &Manager{
		cfg:        &config.Config{OpenClawDir: openClawDir},
		plugins:    map[string]*InstalledPlugin{},
		pluginsDir: pluginsDir,
		configFile: filepath.Join(dir, "plugins.json"),
	}

	// Record state before scan
	manifestPath := filepath.Join(pluginDir, "openclaw.plugin.json")
	ocConfigPath := filepath.Join(openClawDir, "openclaw.json")

	m.scanInstalledPlugins()

	// Plugin should be discovered in memory
	p, ok := m.plugins["test-plugin"]
	if !ok {
		t.Fatalf("expected scan to discover test-plugin")
	}
	if !p.NeedManifestRepair {
		t.Fatalf("expected NeedManifestRepair to be true for plugin without manifest")
	}
	if !p.NeedConfigSync {
		t.Fatalf("expected NeedConfigSync to be true for newly-discovered plugin")
	}

	// No files should have been written
	if _, err := os.Stat(manifestPath); !os.IsNotExist(err) {
		t.Fatalf("scanInstalledPlugins should not create openclaw.plugin.json, but it exists")
	}
	if _, err := os.Stat(ocConfigPath); !os.IsNotExist(err) {
		t.Fatalf("scanInstalledPlugins should not create/modify openclaw.json, but it exists")
	}
}

// TestReconcilePluginStatesWritesDeferredChanges verifies that
// reconcilePluginStates writes the manifest and config files for flagged
// plugins and clears the flags afterwards.
func TestReconcilePluginStatesWritesDeferredChanges(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	openClawDir := filepath.Join(dir, "openclaw")
	if err := os.MkdirAll(openClawDir, 0o755); err != nil {
		t.Fatalf("mkdir openclaw dir: %v", err)
	}
	pluginsDir := filepath.Join(dir, "extensions")
	pluginDir := filepath.Join(pluginsDir, "reconcile-plugin")
	if err := os.MkdirAll(pluginDir, 0o755); err != nil {
		t.Fatalf("mkdir plugin dir: %v", err)
	}

	data, _ := json.Marshal(map[string]interface{}{
		"id":          "reconcile-plugin",
		"name":        "Reconcile Plugin",
		"version":     "2.0.0",
		"description": "for reconcile test",
	})
	if err := os.WriteFile(filepath.Join(pluginDir, "plugin.json"), data, 0o644); err != nil {
		t.Fatalf("write plugin.json: %v", err)
	}

	m := &Manager{
		cfg:        &config.Config{OpenClawDir: openClawDir},
		plugins:    map[string]*InstalledPlugin{},
		pluginsDir: pluginsDir,
		configFile: filepath.Join(dir, "plugins.json"),
	}

	// Scan (read-only) then reconcile (writes)
	m.scanInstalledPlugins()
	m.reconcilePluginStates()

	p := m.plugins["reconcile-plugin"]
	if p == nil {
		t.Fatalf("expected plugin to be present after reconcile")
	}
	if p.NeedManifestRepair {
		t.Fatalf("expected NeedManifestRepair to be cleared after reconcile")
	}
	if p.NeedConfigSync {
		t.Fatalf("expected NeedConfigSync to be cleared after reconcile")
	}

	// Manifest should now exist
	manifestPath := filepath.Join(pluginDir, "openclaw.plugin.json")
	if _, err := os.Stat(manifestPath); err != nil {
		t.Fatalf("expected openclaw.plugin.json to be created by reconcile: %v", err)
	}

	// openclaw.json should have the plugin entry
	ocConfigPath := filepath.Join(openClawDir, "openclaw.json")
	raw, err := os.ReadFile(ocConfigPath)
	if err != nil {
		t.Fatalf("expected openclaw.json to be written: %v", err)
	}
	var ocConfig map[string]interface{}
	if err := json.Unmarshal(raw, &ocConfig); err != nil {
		t.Fatalf("invalid openclaw.json: %v", err)
	}
	plugins, _ := ocConfig["plugins"].(map[string]interface{})
	entries, _ := plugins["entries"].(map[string]interface{})
	if _, ok := entries["reconcile-plugin"]; !ok {
		t.Fatalf("expected reconcile-plugin in openclaw.json entries")
	}
}
