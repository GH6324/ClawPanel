package handler

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zhaoxinyi02/ClawPanel/internal/config"
)

const panelChatDefaultTitle = "新对话"

var errPanelChatTimeout = errors.New("panel chat timeout")
var errPanelChatCanceled = errors.New("panel chat canceled")

var panelChatTimestampPrefixRe = regexp.MustCompile(`^\[[^\]]+\]\s*`)

const panelChatScannerMaxTokenSize = 16 * 1024 * 1024

var panelChatActiveRuns sync.Map

type panelChatActiveRun struct {
	cancel context.CancelFunc
	pid    int
}

type panelChatSession struct {
	ID                string `json:"id"`
	OpenClawSessionID string `json:"openclawSessionId"`
	AgentID           string `json:"agentId"`
	ChatType          string `json:"chatType"`
	Title             string `json:"title"`
	TargetID          string `json:"targetId,omitempty"`
	TargetName        string `json:"targetName,omitempty"`
	CreatedAt         int64  `json:"createdAt"`
	UpdatedAt         int64  `json:"updatedAt"`
	Processing        bool   `json:"processing,omitempty"`
	MessageCount      int    `json:"messageCount"`
	LastMessage       string `json:"lastMessage,omitempty"`
}

type panelChatRunResult struct {
	Payloads []struct {
		Text string `json:"text"`
	} `json:"payloads"`
}

type panelChatCLIResult struct {
	Status string             `json:"status"`
	Result panelChatRunResult `json:"result"`
}

func panelChatSessionsPath(cfg *config.Config) string {
	return filepath.Join(cfg.DataDir, "panel-chat", "sessions.json")
}

func loadPanelChatSessions(cfg *config.Config) ([]panelChatSession, error) {
	path := panelChatSessionsPath(cfg)
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []panelChatSession{}, nil
		}
		return nil, err
	}
	var sessions []panelChatSession
	if len(strings.TrimSpace(string(data))) == 0 {
		return []panelChatSession{}, nil
	}
	if err := json.Unmarshal(data, &sessions); err != nil {
		return nil, err
	}
	return sessions, nil
}

func savePanelChatSessions(cfg *config.Config, sessions []panelChatSession) error {
	path := panelChatSessionsPath(cfg)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(sessions, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0644)
}

func sortPanelChatSessions(sessions []panelChatSession) {
	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].UpdatedAt == sessions[j].UpdatedAt {
			return sessions[i].CreatedAt > sessions[j].CreatedAt
		}
		return sessions[i].UpdatedAt > sessions[j].UpdatedAt
	})
}

func findPanelChatSession(sessions []panelChatSession, id string) (int, *panelChatSession) {
	for i := range sessions {
		if sessions[i].ID == id {
			return i, &sessions[i]
		}
	}
	return -1, nil
}

func normalizePanelChatType(chatType string) string {
	chatType = strings.TrimSpace(strings.ToLower(chatType))
	switch chatType {
	case "", "direct":
		return "direct"
	case "group":
		return "group"
	default:
		return "direct"
	}
}

func buildPanelChatTitle(input string) string {
	input = strings.TrimSpace(input)
	if input == "" {
		return panelChatDefaultTitle
	}
	runes := []rune(input)
	if len(runes) > 24 {
		return strings.TrimSpace(string(runes[:24])) + "..."
	}
	return input
}

func panelChatSessionFile(cfg *config.Config, agentID, openclawSessionID string) string {
	return filepath.Join(resolveAgentSessionsDir(cfg, agentID), openclawSessionID+".jsonl")
}

func sanitizePanelChatContent(content string) string {
	content = strings.TrimSpace(content)
	content = strings.TrimPrefix(content, "[[reply_to_current]]")
	content = panelChatTimestampPrefixRe.ReplaceAllString(content, "")
	return strings.TrimSpace(content)
}

func extractPanelChatPayloads(content interface{}) (string, []map[string]string) {
	if content == nil {
		return "", nil
	}
	if s, ok := content.(string); ok {
		return sanitizePanelChatContent(s), nil
	}
	items, ok := content.([]interface{})
	if !ok {
		return "", nil
	}
	parts := make([]string, 0, len(items))
	images := make([]map[string]string, 0)
	for _, item := range items {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		t, _ := m["type"].(string)
		switch t {
		case "text":
			if text, _ := m["text"].(string); strings.TrimSpace(text) != "" {
				parts = append(parts, sanitizePanelChatContent(text))
			}
		case "image":
			data, _ := m["data"].(string)
			if strings.TrimSpace(data) == "" {
				continue
			}
			mimeType, _ := m["mimeType"].(string)
			if mimeType == "" {
				mimeType, _ = m["mediaType"].(string)
			}
			if mimeType == "" {
				mimeType = "image/png"
			}
			src := data
			if !strings.HasPrefix(src, "data:") {
				src = fmt.Sprintf("data:%s;base64,%s", mimeType, data)
			}
			images = append(images, map[string]string{"src": src, "mimeType": mimeType})
		}
	}
	text := strings.TrimSpace(strings.Join(parts, "\n"))
	if len(images) > 0 && strings.HasPrefix(text, "Read image file [") {
		text = ""
	}
	return text, images
}

func readPanelChatMessages(cfg *config.Config, session panelChatSession) ([]map[string]interface{}, error) {
	filePath := panelChatSessionFile(cfg, session.AgentID, session.OpenClawSessionID)
	if _, err := os.Stat(filePath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []map[string]interface{}{}, nil
		}
		return nil, err
	}

	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	messages := make([]map[string]interface{}, 0, 64)
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), panelChatScannerMaxTokenSize)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry map[string]interface{}
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entryType, _ := entry["type"].(string); entryType != "message" && entryType != "assistant" {
			continue
		}
		msg, ok := entry["message"].(map[string]interface{})
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)
		content, images := extractPanelChatPayloads(msg["content"])
		if role != "user" && role != "assistant" {
			if role == "toolResult" && len(images) > 0 {
				role = "assistant"
			} else {
				continue
			}
		}
		if content == "" {
			if errMsg, _ := msg["errorMessage"].(string); strings.TrimSpace(errMsg) != "" {
				content = errMsg
			}
		}
		if content == "" && len(images) == 0 {
			continue
		}
		ts, _ := entry["timestamp"].(string)
		message := map[string]interface{}{
			"id":        entry["id"],
			"role":      role,
			"content":   content,
			"timestamp": ts,
		}
		if len(images) > 0 {
			message["images"] = images
		}
		messages = append(messages, message)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(messages) > 400 {
		messages = messages[len(messages)-400:]
	}
	return messages, nil
}

func newPanelChatExecCommand(ctx context.Context, cfg *config.Config, session panelChatSession, message string) (*exec.Cmd, error) {
	baseCmd, err := cfg.OpenClawCommand("agent", "--session-id", session.OpenClawSessionID, "--message", message, "--json")
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, baseCmd.Path, baseCmd.Args[1:]...)
	setPanelChatProcessGroup(cmd)
	cmd.Dir = baseCmd.Dir
	cmd.Env = append(config.BuildExecEnv(),
		fmt.Sprintf("OPENCLAW_DIR=%s", cfg.OpenClawDir),
		fmt.Sprintf("OPENCLAW_STATE_DIR=%s", cfg.OpenClawDir),
		fmt.Sprintf("OPENCLAW_CONFIG_PATH=%s", filepath.Join(cfg.OpenClawDir, "openclaw.json")),
	)
	if cfg.OpenClawWork != "" {
		cmd.Env = append(cmd.Env, fmt.Sprintf("OPENCLAW_WORK_DIR=%s", cfg.OpenClawWork))
	}
	if cfg.OpenClawApp != "" {
		cmd.Env = append(cmd.Env, fmt.Sprintf("OPENCLAW_APP=%s", cfg.OpenClawApp))
	}
	return cmd, nil
}

func extractPanelChatJSON(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if idx := strings.LastIndex(raw, "\n{"); idx >= 0 {
		return strings.TrimSpace(raw[idx+1:])
	}
	if idx := strings.Index(raw, "{"); idx >= 0 {
		return strings.TrimSpace(raw[idx:])
	}
	return raw
}

func runPanelChatMessage(ctx context.Context, cfg *config.Config, session panelChatSession, message string) (string, error) {
	baseCtx, baseCancel := context.WithCancel(ctx)
	defer baseCancel()
	ctx, timeoutCancel := context.WithTimeout(baseCtx, 70*time.Second)
	defer timeoutCancel()
	panelChatActiveRuns.Store(session.ID, panelChatActiveRun{cancel: baseCancel})
	defer panelChatActiveRuns.Delete(session.ID)
	cmd, err := newPanelChatExecCommand(ctx, cfg, session, message)
	if err != nil {
		return "", err
	}
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	waitCh := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		return "", err
	}
	panelChatActiveRuns.Store(session.ID, panelChatActiveRun{cancel: baseCancel, pid: cmd.Process.Pid})
	go func() {
		waitCh <- cmd.Wait()
	}()
	var waitErr error
	select {
	case <-ctx.Done():
		killPanelChatProcess(cmd)
		waitErr = <-waitCh
	case waitErr = <-waitCh:
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return "", errPanelChatCanceled
	}
	if ctx.Err() == context.DeadlineExceeded {
		return "", errPanelChatTimeout
	}
	if waitErr != nil {
		trimmed := strings.TrimSpace(output.String())
		if trimmed == "" {
			trimmed = waitErr.Error()
		}
		return "", fmt.Errorf("%s", trimmed)
	}

	jsonText := extractPanelChatJSON(output.String())
	var result panelChatCLIResult
	if err := json.Unmarshal([]byte(jsonText), &result); err != nil {
		return "", fmt.Errorf("无法解析 OpenClaw 返回结果")
	}

	parts := make([]string, 0, len(result.Result.Payloads))
	for _, payload := range result.Result.Payloads {
		text := strings.TrimSpace(payload.Text)
		if text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n\n"), nil
}

func CancelPanelChatMessage(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		sessionID := strings.TrimSpace(c.Param("id"))
		if sessionID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "session id required"})
			return
		}
		if active, ok := panelChatActiveRuns.Load(sessionID); ok {
			active.(panelChatActiveRun).cancel()
		}
		if _, err := updatePanelChatSessionState(cfg, sessionID, func(item *panelChatSession) {
			item.Processing = false
			item.UpdatedAt = time.Now().UnixMilli()
		}); err != nil {
			c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "canceled": true})
	}
}

func panelChatEffectiveReply(messages []map[string]interface{}, fallback string) string {
	if strings.TrimSpace(fallback) != "" {
		return fallback
	}
	for i := len(messages) - 1; i >= 0; i-- {
		if role, _ := messages[i]["role"].(string); role == "assistant" {
			if content, _ := messages[i]["content"].(string); strings.TrimSpace(content) != "" {
				return content
			}
		}
	}
	return ""
}

func updatePanelChatSessionState(cfg *config.Config, sessionID string, mutate func(*panelChatSession)) (*panelChatSession, error) {
	sessions, err := loadPanelChatSessions(cfg)
	if err != nil {
		return nil, err
	}
	idx, session := findPanelChatSession(sessions, sessionID)
	if session == nil {
		return nil, fmt.Errorf("会话不存在")
	}
	mutate(&sessions[idx])
	sortPanelChatSessions(sessions)
	if err := savePanelChatSessions(cfg, sessions); err != nil {
		return nil, err
	}
	for i := range sessions {
		if sessions[i].ID == sessionID {
			return &sessions[i], nil
		}
	}
	return &sessions[0], nil
}

func ListPanelChatSessions(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		sessions, err := loadPanelChatSessions(cfg)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
			return
		}
		sortPanelChatSessions(sessions)
		c.JSON(http.StatusOK, gin.H{"ok": true, "sessions": sessions})
	}
}

func CreatePanelChatSession(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Title      string `json:"title"`
			ChatType   string `json:"chatType"`
			AgentID    string `json:"agentId"`
			TargetID   string `json:"targetId"`
			TargetName string `json:"targetName"`
		}
		_ = c.ShouldBindJSON(&req)

		agentID := strings.TrimSpace(req.AgentID)
		if agentID == "" {
			agentID = loadDefaultAgentID(cfg)
		}
		chatType := normalizePanelChatType(req.ChatType)
		now := time.Now().UnixMilli()
		id := fmt.Sprintf("panel-%d", now)
		session := panelChatSession{
			ID:                id,
			OpenClawSessionID: id,
			AgentID:           agentID,
			ChatType:          chatType,
			Title:             buildPanelChatTitle(req.Title),
			TargetID:          strings.TrimSpace(req.TargetID),
			TargetName:        strings.TrimSpace(req.TargetName),
			CreatedAt:         now,
			UpdatedAt:         now,
		}

		sessions, err := loadPanelChatSessions(cfg)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
			return
		}
		sessions = append(sessions, session)
		sortPanelChatSessions(sessions)
		if err := savePanelChatSessions(cfg, sessions); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "session": session})
	}
}

func GetPanelChatSessionDetail(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		sessions, err := loadPanelChatSessions(cfg)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
			return
		}
		_, session := findPanelChatSession(sessions, c.Param("id"))
		if session == nil {
			c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "会话不存在"})
			return
		}
		messages, err := readPanelChatMessages(cfg, *session)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "session": session, "messages": messages})
	}
}

func RenamePanelChatSession(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Title string `json:"title"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "title required"})
			return
		}
		title := buildPanelChatTitle(req.Title)
		session, err := updatePanelChatSessionState(cfg, c.Param("id"), func(item *panelChatSession) {
			item.Title = title
			item.UpdatedAt = time.Now().UnixMilli()
		})
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "session": session})
	}
}

func SendPanelChatMessage(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Message string `json:"message"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Message) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "message required"})
			return
		}
		if !cfg.OpenClawInstalled() {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "OpenClaw 未安装或未配置"})
			return
		}

		sessions, err := loadPanelChatSessions(cfg)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
			return
		}
		_, session := findPanelChatSession(sessions, c.Param("id"))
		if session == nil {
			c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "会话不存在"})
			return
		}
		if _, err := updatePanelChatSessionState(cfg, session.ID, func(item *panelChatSession) {
			item.Processing = true
			item.UpdatedAt = time.Now().UnixMilli()
			item.LastMessage = strings.TrimSpace(req.Message)
		}); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
			return
		}

		reply, runErr := runPanelChatMessage(c.Request.Context(), cfg, *session, strings.TrimSpace(req.Message))
		_, _ = updatePanelChatSessionState(cfg, session.ID, func(item *panelChatSession) {
			item.Processing = false
		})
		if runErr != nil {
			if errors.Is(runErr, errPanelChatCanceled) {
				c.JSON(http.StatusOK, gin.H{"ok": false, "canceled": true})
				return
			}
			if !errors.Is(runErr, errPanelChatTimeout) {
				c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": runErr.Error()})
				return
			}
		}
		messages, err := readPanelChatMessages(cfg, *session)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
			return
		}

		reply = panelChatEffectiveReply(messages, reply)
		updated, err := updatePanelChatSessionState(cfg, session.ID, func(item *panelChatSession) {
			item.UpdatedAt = time.Now().UnixMilli()
			item.Processing = false
			item.MessageCount = len(messages)
			item.LastMessage = strings.TrimSpace(req.Message)
			if item.Title == panelChatDefaultTitle && len(messages) > 0 {
				item.Title = buildPanelChatTitle(req.Message)
			}
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"ok":         true,
			"reply":      reply,
			"session":    updated,
			"messages":   messages,
			"processing": errors.Is(runErr, errPanelChatTimeout),
		})
	}
}

func DeletePanelChatSession(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		sessions, err := loadPanelChatSessions(cfg)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
			return
		}
		idx, session := findPanelChatSession(sessions, c.Param("id"))
		if session == nil {
			c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "会话不存在"})
			return
		}
		sessions = append(sessions[:idx], sessions[idx+1:]...)
		if err := savePanelChatSessions(cfg, sessions); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
			return
		}
		_ = os.Remove(panelChatSessionFile(cfg, session.AgentID, session.OpenClawSessionID))
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}
