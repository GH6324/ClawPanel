package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadOpenClawJSONSupportsJSON5AndWriteCreatesBackup(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	cfg := &Config{OpenClawDir: dir}

	json5Raw := `{
  // json5 comment
  tools: {
    agentToAgent: true,
  },
  session: {
    maxMessages: 30,
  },
  agents: {
    default: "main",
    list: [
      { id: "main", },
    ],
  },
}`
	configPath := filepath.Join(dir, "openclaw.json")
	if err := os.WriteFile(configPath, []byte(json5Raw), 0644); err != nil {
		t.Fatalf("write openclaw.json: %v", err)
	}

	parsed, err := cfg.ReadOpenClawJSON()
	if err != nil {
		t.Fatalf("ReadOpenClawJSON should parse JSON5, got error: %v", err)
	}
	if _, ok := parsed["tools"].(map[string]interface{}); !ok {
		t.Fatalf("tools should exist after JSON5 parse")
	}
	if _, ok := parsed["session"].(map[string]interface{}); !ok {
		t.Fatalf("session should exist after JSON5 parse")
	}

	if err := cfg.WriteOpenClawJSON(parsed); err != nil {
		t.Fatalf("WriteOpenClawJSON failed: %v", err)
	}

	backupDir := filepath.Join(dir, "backups")
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		t.Fatalf("backup dir should exist: %v", err)
	}
	found := false
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "pre-edit-") && strings.HasSuffix(e.Name(), ".json") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected pre-edit backup file to be created")
	}

	raw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read written config: %v", err)
	}
	var written map[string]interface{}
	if err := json.Unmarshal(raw, &written); err != nil {
		t.Fatalf("written config should be standard JSON: %v", err)
	}
	if _, ok := written["tools"]; !ok {
		t.Fatalf("written config should preserve tools")
	}
	if _, ok := written["session"]; !ok {
		t.Fatalf("written config should preserve session")
	}
	agents, _ := written["agents"].(map[string]interface{})
	if agents == nil {
		t.Fatalf("written config should preserve agents")
	}
	if _, ok := agents["default"]; ok {
		t.Fatalf("legacy agents.default should be removed on write")
	}
	list, _ := agents["list"].([]interface{})
	if len(list) != 1 {
		t.Fatalf("expected one agent in list, got %d", len(list))
	}
	item, _ := list[0].(map[string]interface{})
	if item == nil || item["default"] != true {
		t.Fatalf("legacy default agent should migrate to agents.list[].default=true, got %#v", item)
	}
}

func TestWriteOpenClawJSONNormalizesLegacyAgentModelFields(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	cfg := &Config{OpenClawDir: dir}

	input := map[string]interface{}{
		"agents": map[string]interface{}{
			"defaults": map[string]interface{}{
				"model": map[string]interface{}{
					"primary":       "cpa/gemini-3.1-pro-preview",
					"contextTokens": 200000,
					"maxTokens":     8192,
				},
			},
		},
	}

	if err := cfg.WriteOpenClawJSON(input); err != nil {
		t.Fatalf("WriteOpenClawJSON failed: %v", err)
	}

	saved, err := cfg.ReadOpenClawJSON()
	if err != nil {
		t.Fatalf("ReadOpenClawJSON failed: %v", err)
	}

	agents, _ := saved["agents"].(map[string]interface{})
	defaults, _ := agents["defaults"].(map[string]interface{})
	if defaults == nil {
		t.Fatalf("agents.defaults should exist")
	}
	if _, ok := defaults["contextTokens"]; !ok {
		t.Fatalf("legacy contextTokens should be migrated to agents.defaults.contextTokens")
	}

	model, _ := defaults["model"].(map[string]interface{})
	if model == nil {
		t.Fatalf("agents.defaults.model should still exist")
	}
	if _, ok := model["contextTokens"]; ok {
		t.Fatalf("agents.defaults.model.contextTokens should be removed")
	}
	if _, ok := model["maxTokens"]; ok {
		t.Fatalf("agents.defaults.model.maxTokens should be removed")
	}
}

func TestNormalizeOpenClawConfigDropsUnsupportedPerAgentContextOverrides(t *testing.T) {
	t.Parallel()

	input := map[string]interface{}{
		"agents": map[string]interface{}{
			"defaults": map[string]interface{}{
				"contextTokens": 200000,
				"compaction": map[string]interface{}{
					"mode": "safeguard",
				},
			},
			"list": []interface{}{
				map[string]interface{}{
					"id":            "main",
					"contextTokens": 4096,
					"compaction": map[string]interface{}{
						"mode":            "safeguard",
						"maxHistoryShare": 0.5,
					},
				},
			},
		},
	}

	if changed := NormalizeOpenClawConfig(input); !changed {
		t.Fatalf("NormalizeOpenClawConfig should report changes when dropping unsupported per-agent context overrides")
	}

	agents, _ := input["agents"].(map[string]interface{})
	defaults, _ := agents["defaults"].(map[string]interface{})
	if got := defaults["contextTokens"]; got != 200000 {
		t.Fatalf("expected agents.defaults.contextTokens to stay intact, got %#v", got)
	}
	if _, ok := defaults["compaction"]; !ok {
		t.Fatalf("expected agents.defaults.compaction to stay intact")
	}

	list, _ := agents["list"].([]interface{})
	if len(list) != 1 {
		t.Fatalf("expected one agent, got %#v", list)
	}
	item, _ := list[0].(map[string]interface{})
	if _, ok := item["contextTokens"]; ok {
		t.Fatalf("expected unsupported per-agent contextTokens to be removed, got %#v", item["contextTokens"])
	}
	if _, ok := item["compaction"]; ok {
		t.Fatalf("expected unsupported per-agent compaction to be removed, got %#v", item["compaction"])
	}
}

func TestNormalizeOpenClawJSONFileRewritesUnsupportedPerAgentContextOverrides(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	cfg := &Config{OpenClawDir: dir}
	raw := `{
  "agents": {
    "list": [
      {
        "id": "main",
        "contextTokens": 4096,
        "compaction": {
          "mode": "safeguard",
          "maxHistoryShare": 0.5
        }
      }
    ]
  }
}`
	if err := os.WriteFile(filepath.Join(dir, "openclaw.json"), []byte(raw), 0644); err != nil {
		t.Fatalf("write openclaw.json: %v", err)
	}

	changed, err := cfg.NormalizeOpenClawJSONFile()
	if err != nil {
		t.Fatalf("NormalizeOpenClawJSONFile failed: %v", err)
	}
	if !changed {
		t.Fatalf("expected NormalizeOpenClawJSONFile to rewrite unsupported per-agent context overrides")
	}

	saved, err := cfg.ReadOpenClawJSON()
	if err != nil {
		t.Fatalf("ReadOpenClawJSON failed: %v", err)
	}
	agents, _ := saved["agents"].(map[string]interface{})
	list, _ := agents["list"].([]interface{})
	if len(list) != 1 {
		t.Fatalf("expected one agent, got %#v", list)
	}
	item, _ := list[0].(map[string]interface{})
	if _, ok := item["contextTokens"]; ok {
		t.Fatalf("expected contextTokens to be removed from saved file, got %#v", item["contextTokens"])
	}
	if _, ok := item["compaction"]; ok {
		t.Fatalf("expected compaction to be removed from saved file, got %#v", item["compaction"])
	}
}

func TestWriteOpenClawJSONNormalizesLegacyAgentSandboxModes(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	cfg := &Config{OpenClawDir: dir}

	input := map[string]interface{}{
		"agents": map[string]interface{}{
			"defaults": map[string]interface{}{
				"sandbox": map[string]interface{}{
					"mode": "danger-full-access",
				},
			},
			"list": []interface{}{
				map[string]interface{}{
					"id": "main",
					"sandbox": map[string]interface{}{
						"mode": "workspace-write",
					},
				},
				map[string]interface{}{
					"id":      "work",
					"default": true,
					"sandbox": map[string]interface{}{
						"mode": "read-only",
					},
				},
			},
		},
	}

	if err := cfg.WriteOpenClawJSON(input); err != nil {
		t.Fatalf("WriteOpenClawJSON failed: %v", err)
	}

	saved, err := cfg.ReadOpenClawJSON()
	if err != nil {
		t.Fatalf("ReadOpenClawJSON failed: %v", err)
	}

	agents, _ := saved["agents"].(map[string]interface{})
	defaults, _ := agents["defaults"].(map[string]interface{})
	defaultSandbox, _ := defaults["sandbox"].(map[string]interface{})
	if got, _ := defaultSandbox["mode"].(string); got != "off" {
		t.Fatalf("expected defaults sandbox.mode to normalize to off, got %q", got)
	}

	list, _ := agents["list"].([]interface{})
	if len(list) != 2 {
		t.Fatalf("expected two agents, got %d", len(list))
	}
	mainItem, _ := list[0].(map[string]interface{})
	mainSandbox, _ := mainItem["sandbox"].(map[string]interface{})
	if got, _ := mainSandbox["mode"].(string); got != "all" {
		t.Fatalf("expected workspace-write to normalize mode=all, got %q", got)
	}
	if got, _ := mainSandbox["workspaceAccess"].(string); got != "rw" {
		t.Fatalf("expected workspace-write to normalize workspaceAccess=rw, got %q", got)
	}
	workItem, _ := list[1].(map[string]interface{})
	workSandbox, _ := workItem["sandbox"].(map[string]interface{})
	if got, _ := workSandbox["mode"].(string); got != "all" {
		t.Fatalf("expected read-only to normalize mode=all, got %q", got)
	}
	if got, _ := workSandbox["workspaceAccess"].(string); got != "ro" {
		t.Fatalf("expected read-only to normalize workspaceAccess=ro, got %q", got)
	}
}

func TestWriteOpenClawJSONPrefersListDefaultOverLegacyKey(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	cfg := &Config{OpenClawDir: dir}

	input := map[string]interface{}{
		"agents": map[string]interface{}{
			"default": "main",
			"list": []interface{}{
				map[string]interface{}{"id": "main"},
				map[string]interface{}{"id": "work", "default": true},
			},
		},
	}

	if err := cfg.WriteOpenClawJSON(input); err != nil {
		t.Fatalf("WriteOpenClawJSON failed: %v", err)
	}

	saved, err := cfg.ReadOpenClawJSON()
	if err != nil {
		t.Fatalf("ReadOpenClawJSON failed: %v", err)
	}

	agents, _ := saved["agents"].(map[string]interface{})
	if _, ok := agents["default"]; ok {
		t.Fatalf("legacy agents.default should be removed")
	}
	list, _ := agents["list"].([]interface{})
	if len(list) != 2 {
		t.Fatalf("expected two agents, got %d", len(list))
	}
	first, _ := list[0].(map[string]interface{})
	second, _ := list[1].(map[string]interface{})
	if _, ok := first["default"]; ok {
		t.Fatalf("expected main to stay non-default when list default already exists, got %#v", first)
	}
	if got := second["default"]; got != true {
		t.Fatalf("expected work to remain explicit default, got %#v", second)
	}
}

func TestComputeRuntimeExtraBinPathsForWindowsIncludesCommonRuntimeDirs(t *testing.T) {
	t.Parallel()

	home := `C:\Users\Alice`
	paths := computeRuntimeExtraBinPathsForOS("windows", home)

	wants := []string{
		filepath.Join(home, "AppData", "Roaming", "npm"),
		filepath.Join(home, "AppData", "Local", "Microsoft", "WindowsApps"),
		filepath.Join(home, "scoop", "shims"),
		`C:\Program Files\nodejs`,
		`C:\Program Files\Git\cmd`,
		`C:\Program Files\Git\bin`,
		`C:\Program Files\Git\mingw64\bin`,
		`C:\ProgramData\chocolatey\bin`,
		`C:\ClawPanel\npm-global`,
	}

	set := map[string]bool{}
	for _, item := range paths {
		set[item] = true
	}
	for _, want := range wants {
		if !set[want] {
			t.Fatalf("expected windows runtime path list to include %q, got %#v", want, paths)
		}
	}
}

func TestWriteOpenClawJSONMaterializesDiskOnlyLegacyDefault(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	cfg := &Config{OpenClawDir: dir}
	if err := os.MkdirAll(filepath.Join(dir, "agents", "main"), 0755); err != nil {
		t.Fatalf("mkdir main agent dir: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "agents", "work"), 0755); err != nil {
		t.Fatalf("mkdir work agent dir: %v", err)
	}

	input := map[string]interface{}{
		"agents": map[string]interface{}{
			"default": "work",
		},
	}

	if err := cfg.WriteOpenClawJSON(input); err != nil {
		t.Fatalf("WriteOpenClawJSON failed: %v", err)
	}

	saved, err := cfg.ReadOpenClawJSON()
	if err != nil {
		t.Fatalf("ReadOpenClawJSON failed: %v", err)
	}

	agents, _ := saved["agents"].(map[string]interface{})
	if _, ok := agents["default"]; ok {
		t.Fatalf("legacy agents.default should be removed")
	}
	list, _ := agents["list"].([]interface{})
	if len(list) != 2 {
		t.Fatalf("expected synthesized list for disk agents, got %#v", list)
	}
	var workItem map[string]interface{}
	for _, raw := range list {
		item, _ := raw.(map[string]interface{})
		if item != nil && item["id"] == "work" {
			workItem = item
			break
		}
	}
	if workItem == nil || workItem["default"] != true {
		t.Fatalf("expected disk-backed work agent to become explicit default, got %#v", list)
	}
}

func TestWriteOpenClawJSONMaterializesLegacyMainWithoutDiskDir(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	cfg := &Config{OpenClawDir: dir}

	input := map[string]interface{}{
		"agents": map[string]interface{}{
			"default": "main",
		},
	}

	if err := cfg.WriteOpenClawJSON(input); err != nil {
		t.Fatalf("WriteOpenClawJSON failed: %v", err)
	}

	saved, err := cfg.ReadOpenClawJSON()
	if err != nil {
		t.Fatalf("ReadOpenClawJSON failed: %v", err)
	}

	agents, _ := saved["agents"].(map[string]interface{})
	if _, ok := agents["default"]; ok {
		t.Fatalf("legacy agents.default should be removed")
	}
	list, _ := agents["list"].([]interface{})
	if len(list) != 1 {
		t.Fatalf("expected synthesized explicit main agent, got %#v", list)
	}
	item, _ := list[0].(map[string]interface{})
	if item == nil || item["id"] != "main" || item["default"] != true {
		t.Fatalf("expected main to be materialized as explicit default, got %#v", item)
	}
}

func TestNormalizeOpenClawConfigKeepsDiskOnlyLegacyDefaultWithoutStateDir(t *testing.T) {
	t.Parallel()

	input := map[string]interface{}{
		"agents": map[string]interface{}{
			"default": "work",
		},
	}

	if changed := NormalizeOpenClawConfig(input); changed {
		t.Fatalf("NormalizeOpenClawConfig should not drop legacy default when no list/state dir is available")
	}

	agents, _ := input["agents"].(map[string]interface{})
	if got, _ := agents["default"].(string); got != "work" {
		t.Fatalf("expected legacy default to remain for runtime compatibility, got %q", got)
	}
}

func TestWriteOpenClawJSONNormalizesLegacyPanelFields(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	cfg := &Config{OpenClawDir: dir}

	input := map[string]interface{}{
		"gateway": map[string]interface{}{
			"mode":        "hosted",
			"bindAddress": "0.0.0.0",
		},
		"hooks": map[string]interface{}{
			"enabled":  true,
			"basePath": "/hooks",
			"secret":   "test-token",
		},
		"messages": map[string]interface{}{
			"systemPrompt":       "legacy",
			"maxHistoryMessages": 50,
			"ackReactionScope":   "group-mentions",
		},
	}

	if err := cfg.WriteOpenClawJSON(input); err != nil {
		t.Fatalf("WriteOpenClawJSON failed: %v", err)
	}

	saved, err := cfg.ReadOpenClawJSON()
	if err != nil {
		t.Fatalf("ReadOpenClawJSON failed: %v", err)
	}

	gateway, _ := saved["gateway"].(map[string]interface{})
	if gateway == nil {
		t.Fatalf("gateway should exist")
	}
	if got, _ := gateway["mode"].(string); got != "remote" {
		t.Fatalf("gateway.mode should normalize to remote, got %q", got)
	}
	if got, _ := gateway["customBindHost"].(string); got != "0.0.0.0" {
		t.Fatalf("gateway.customBindHost should be migrated, got %q", got)
	}
	if _, ok := gateway["bindAddress"]; ok {
		t.Fatalf("gateway.bindAddress should be removed")
	}

	hooks, _ := saved["hooks"].(map[string]interface{})
	if hooks == nil {
		t.Fatalf("hooks should exist")
	}
	if got, _ := hooks["path"].(string); got != "/hooks" {
		t.Fatalf("hooks.path should be migrated, got %q", got)
	}
	if got, _ := hooks["token"].(string); got != "test-token" {
		t.Fatalf("hooks.token should be migrated, got %q", got)
	}
	if _, ok := hooks["basePath"]; ok {
		t.Fatalf("hooks.basePath should be removed")
	}
	if _, ok := hooks["secret"]; ok {
		t.Fatalf("hooks.secret should be removed")
	}

	messages, _ := saved["messages"].(map[string]interface{})
	if messages == nil {
		t.Fatalf("messages should exist")
	}
	if got, _ := messages["systemPrompt"].(string); got != "legacy" {
		t.Fatalf("messages.systemPrompt should be preserved, got %q", got)
	}
	if got, ok := messages["maxHistoryMessages"].(float64); !ok || int(got) != 50 {
		t.Fatalf("messages.maxHistoryMessages should be preserved, got %#v", messages["maxHistoryMessages"])
	}
}

func TestWriteOpenClawJSONKeepsFeishuDefaultAccountFirstInFile(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	cfg := &Config{OpenClawDir: dir}

	input := map[string]interface{}{
		"channels": map[string]interface{}{
			"feishu": map[string]interface{}{
				"defaultAccount": "fly",
				"accounts": map[string]interface{}{
					"default": map[string]interface{}{
						"appId":     "cli_default",
						"appSecret": "secret_default",
						"enabled":   false,
					},
					"fly": map[string]interface{}{
						"appId":     "cli_fly",
						"appSecret": "secret_fly",
						"enabled":   true,
					},
					"work": map[string]interface{}{
						"appId":     "cli_work",
						"appSecret": "secret_work",
						"enabled":   false,
					},
				},
			},
		},
	}

	if err := cfg.WriteOpenClawJSON(input); err != nil {
		t.Fatalf("WriteOpenClawJSON failed: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "openclaw.json"))
	if err != nil {
		t.Fatalf("read written config: %v", err)
	}
	text := string(raw)
	accountsIdx := strings.Index(text, "\"accounts\": {")
	if accountsIdx < 0 {
		t.Fatalf("expected accounts block in written config, got %s", text)
	}
	accountsBlock := text[accountsIdx:]
	flyIdx := strings.Index(accountsBlock, "\"fly\": {")
	defaultIdx := strings.Index(accountsBlock, "\"default\": {")
	workIdx := strings.Index(accountsBlock, "\"work\": {")
	if flyIdx < 0 || defaultIdx < 0 || workIdx < 0 {
		t.Fatalf("expected all account entries in accounts block, got %s", accountsBlock)
	}
	if flyIdx > defaultIdx || flyIdx > workIdx {
		t.Fatalf("expected default account fly to be written first, got %s", accountsBlock)
	}

	saved, err := cfg.ReadOpenClawJSON()
	if err != nil {
		t.Fatalf("ReadOpenClawJSON failed: %v", err)
	}
	channels, _ := saved["channels"].(map[string]interface{})
	feishu, _ := channels["feishu"].(map[string]interface{})
	if got, _ := feishu["defaultAccount"].(string); got != "fly" {
		t.Fatalf("expected defaultAccount to remain fly after write, got %q", got)
	}
}

func TestReadQQChannelStateSupportsJSON5(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	cfg := &Config{OpenClawDir: dir}

	raw := `{
  channels: {
    qq: {
      enabled: true,
      accessToken: "qq-token",
    },
  },
}`
	if err := os.WriteFile(filepath.Join(dir, "openclaw.json"), []byte(raw), 0644); err != nil {
		t.Fatalf("write openclaw.json: %v", err)
	}

	enabled, token, err := cfg.ReadQQChannelState()
	if err != nil {
		t.Fatalf("ReadQQChannelState failed: %v", err)
	}
	if !enabled {
		t.Fatalf("expected qq channel to be enabled")
	}
	if token != "qq-token" {
		t.Fatalf("expected qq access token to be preserved, got %q", token)
	}
}

// TestMarshalOpenClawJSONMatchesStdlibForNonFeishu verifies that the custom
// serializer produces output equivalent to json.MarshalIndent for all
// non-feishu structures: plugins, cron, hooks, tools, gateway, agents, etc.
// The only expected difference is feishu defaultAccount key ordering.
func TestMarshalOpenClawJSONMatchesStdlibForNonFeishu(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		data map[string]interface{}
	}{
		{
			name: "plugins",
			data: map[string]interface{}{
				"plugins": map[string]interface{}{
					"entries": map[string]interface{}{
						"memory-plugin": map[string]interface{}{"enabled": true},
						"alpha-plugin":  map[string]interface{}{"enabled": false},
					},
					"installs": map[string]interface{}{
						"memory-plugin": map[string]interface{}{
							"source":  "npm",
							"version": "1.0.0",
						},
					},
				},
			},
		},
		{
			name: "cron",
			data: map[string]interface{}{
				"cron": map[string]interface{}{
					"jobs": []interface{}{
						map[string]interface{}{
							"id":       "backup",
							"schedule": "0 2 * * *",
							"task":     "backup database",
						},
					},
				},
			},
		},
		{
			name: "tools",
			data: map[string]interface{}{
				"tools": map[string]interface{}{
					"exec": map[string]interface{}{
						"enabled":  true,
						"commands": []interface{}{"ls", "cat"},
					},
					"browser": map[string]interface{}{
						"enabled": false,
					},
				},
			},
		},
		{
			name: "gateway",
			data: map[string]interface{}{
				"gateway": map[string]interface{}{
					"host":     "0.0.0.0",
					"port":     float64(3000),
					"bindMode": "loopback",
				},
			},
		},
		{
			name: "agents",
			data: map[string]interface{}{
				"agents": map[string]interface{}{
					"defaults": map[string]interface{}{
						"contextTokens": float64(800000),
						"compaction": map[string]interface{}{
							"mode":            "default",
							"maxHistoryShare": 0.8,
						},
					},
				},
			},
		},
		{
			name: "mixed_top_level",
			data: map[string]interface{}{
				"session": map[string]interface{}{
					"dmScope": "user",
				},
				"hooks": map[string]interface{}{
					"onStart": "echo hello",
				},
				"gateway": map[string]interface{}{
					"port": float64(8080),
				},
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			customOut, err := marshalOpenClawJSON(tc.data)
			if err != nil {
				t.Fatalf("marshalOpenClawJSON failed: %v", err)
			}
			stdOut, err := json.MarshalIndent(tc.data, "", "  ")
			if err != nil {
				t.Fatalf("json.MarshalIndent failed: %v", err)
			}

			// Normalize: unmarshal both and compare semantically
			var customParsed, stdParsed interface{}
			if err := json.Unmarshal(customOut, &customParsed); err != nil {
				t.Fatalf("custom output is not valid JSON: %v\n%s", err, customOut)
			}
			if err := json.Unmarshal(stdOut, &stdParsed); err != nil {
				t.Fatalf("stdlib output is not valid JSON: %v", err)
			}
			customCanon, _ := json.Marshal(customParsed)
			stdCanon, _ := json.Marshal(stdParsed)
			if string(customCanon) != string(stdCanon) {
				t.Errorf("semantic mismatch:\ncustom: %s\nstdlib: %s", customOut, stdOut)
			}
		})
	}
}

// TestMarshalOpenClawJSONFeishuDefaultAccountOrdering confirms the custom
// serializer's unique behavior: the feishu defaultAccount is placed first
// in the accounts map, which cannot be achieved with json.MarshalIndent.
func TestMarshalOpenClawJSONFeishuDefaultAccountOrdering(t *testing.T) {
	t.Parallel()

	data := map[string]interface{}{
		"channels": map[string]interface{}{
			"feishu": map[string]interface{}{
				"defaultAccount": "beta",
				"accounts": map[string]interface{}{
					"alpha": map[string]interface{}{"appId": "a"},
					"beta":  map[string]interface{}{"appId": "b"},
					"gamma": map[string]interface{}{"appId": "c"},
				},
			},
		},
	}

	out, err := marshalOpenClawJSON(data)
	if err != nil {
		t.Fatalf("marshalOpenClawJSON failed: %v", err)
	}
	text := string(out)
	accountsIdx := strings.Index(text, `"accounts": {`)
	if accountsIdx < 0 {
		t.Fatalf("no accounts block found")
	}
	sub := text[accountsIdx:]
	betaIdx := strings.Index(sub, `"beta"`)
	alphaIdx := strings.Index(sub, `"alpha"`)
	if betaIdx > alphaIdx {
		t.Fatalf("expected beta (defaultAccount) before alpha, got beta@%d alpha@%d", betaIdx, alphaIdx)
	}
}

// TestWriteOpenClawJSONRoundTrip verifies that data survives a write→read
// cycle intact for non-feishu config structures.
func TestWriteOpenClawJSONRoundTrip(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	cfg := &Config{OpenClawDir: dir}

	input := map[string]interface{}{
		"plugins": map[string]interface{}{
			"entries": map[string]interface{}{
				"my-plugin": map[string]interface{}{"enabled": true},
			},
		},
		"agents": map[string]interface{}{
			"defaults": map[string]interface{}{
				"contextTokens": float64(500000),
			},
		},
		"gateway": map[string]interface{}{
			"port": float64(3000),
		},
	}

	if err := cfg.WriteOpenClawJSON(input); err != nil {
		t.Fatalf("write failed: %v", err)
	}

	output, err := cfg.ReadOpenClawJSON()
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}

	inJSON, _ := json.Marshal(input)
	outJSON, _ := json.Marshal(output)
	if string(inJSON) != string(outJSON) {
		t.Errorf("round-trip mismatch:\ninput:  %s\noutput: %s", inJSON, outJSON)
	}
}
