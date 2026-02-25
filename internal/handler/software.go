package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zhaoxinyi02/ClawPanel/internal/config"
	"github.com/zhaoxinyi02/ClawPanel/internal/taskman"
)

// SoftwareInfo 软件信息
type SoftwareInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Version     string `json:"version"`
	Installed   bool   `json:"installed"`
	Status      string `json:"status"` // installed, not_installed, running, stopped
	Category    string `json:"category"` // runtime, container, service
	Installable bool   `json:"installable"`
	Icon        string `json:"icon,omitempty"`
}

// OpenClawInstance 检测到的 OpenClaw 实例
type OpenClawInstance struct {
	ID      string `json:"id"`
	Type    string `json:"type"` // npm, source, docker, systemd
	Label   string `json:"label"`
	Version string `json:"version"`
	Path    string `json:"path,omitempty"`
	Active  bool   `json:"active"`
	Status  string `json:"status"` // running, stopped, unknown
}

func detectCmd(name string, args ...string) string {
	cmd := exec.Command(name, args...)
	cmd.Env = append(os.Environ(), "PATH="+os.Getenv("PATH")+":/usr/local/bin:/usr/bin:/bin:/snap/bin")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func isDockerContainerRunning(name string) bool {
	out := detectCmd("docker", "inspect", "--format", "{{.State.Running}}", name)
	return out == "true"
}

func getDockerContainerStatus(name string) (bool, string) {
	out := detectCmd("docker", "inspect", "--format", "{{.State.Status}}", name)
	if out == "" {
		return false, "not_installed"
	}
	return true, out // running, exited, etc.
}

// GetSoftwareList 获取软件环境列表
func GetSoftwareList(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		var list []SoftwareInfo

		// Node.js
		nodeVer := detectCmd("node", "--version")
		list = append(list, SoftwareInfo{
			ID: "nodejs", Name: "Node.js", Description: "JavaScript 运行时",
			Version: nodeVer, Installed: nodeVer != "", Installable: true,
			Status: boolStatus(nodeVer != ""), Category: "runtime", Icon: "terminal",
		})

		// npm
		npmVer := detectCmd("npm", "--version")
		list = append(list, SoftwareInfo{
			ID: "npm", Name: "npm", Description: "Node.js 包管理器",
			Version: npmVer, Installed: npmVer != "", Installable: false,
			Status: boolStatus(npmVer != ""), Category: "runtime", Icon: "package",
		})

		// Docker
		dockerVer := detectCmd("docker", "--version")
		list = append(list, SoftwareInfo{
			ID: "docker", Name: "Docker", Description: "容器运行时",
			Version: dockerVer, Installed: dockerVer != "", Installable: true,
			Status: boolStatus(dockerVer != ""), Category: "runtime", Icon: "box",
		})

		// Git
		gitVer := detectCmd("git", "--version")
		list = append(list, SoftwareInfo{
			ID: "git", Name: "Git", Description: "版本控制系统",
			Version: gitVer, Installed: gitVer != "", Installable: true,
			Status: boolStatus(gitVer != ""), Category: "runtime", Icon: "git-branch",
		})

		// Python
		pythonVer := detectCmd("python3", "--version")
		list = append(list, SoftwareInfo{
			ID: "python", Name: "Python 3", Description: "Python 运行时",
			Version: pythonVer, Installed: pythonVer != "", Installable: true,
			Status: boolStatus(pythonVer != ""), Category: "runtime", Icon: "code",
		})

		// OpenClaw
		ocVer := detectOpenClawVersion(cfg)
		list = append(list, SoftwareInfo{
			ID: "openclaw", Name: "OpenClaw", Description: "AI 助手核心引擎",
			Version: ocVer, Installed: ocVer != "", Installable: true,
			Status: boolStatus(ocVer != ""), Category: "service", Icon: "brain",
		})

		// NapCat (QQ)
		napcatExists, napcatStatus := getDockerContainerStatus("openclaw-qq")
		napcatVer := ""
		if napcatExists {
			napcatVer = "Docker"
		}
		list = append(list, SoftwareInfo{
			ID: "napcat", Name: "NapCat (QQ个人号)", Description: "QQ 机器人 OneBot11 协议",
			Version: napcatVer, Installed: napcatExists, Installable: true,
			Status: napcatStatus, Category: "container", Icon: "message-circle",
		})

		// WeChat Bot
		wechatExists, wechatStatus := getDockerContainerStatus("openclaw-wechat")
		wechatVer := ""
		if wechatExists {
			wechatVer = "Docker"
		}
		list = append(list, SoftwareInfo{
			ID: "wechat", Name: "微信机器人", Description: "wechatbot-webhook 微信个人号",
			Version: wechatVer, Installed: wechatExists, Installable: true,
			Status: wechatStatus, Category: "container", Icon: "message-square",
		})

		c.JSON(http.StatusOK, gin.H{"ok": true, "software": list})
	}
}

func boolStatus(installed bool) string {
	if installed {
		return "installed"
	}
	return "not_installed"
}

func detectOpenClawVersion(cfg *config.Config) string {
	// 1. Try openclaw CLI (covers npm global, manual install, any PATH-accessible install)
	ver := detectCmd("openclaw", "--version")
	if ver != "" {
		return strings.TrimPrefix(strings.TrimSpace(ver), "v")
	}

	// 2. Try from config meta.lastTouchedVersion
	ocConfig, _ := cfg.ReadOpenClawJSON()
	if ocConfig != nil {
		if meta, ok := ocConfig["meta"].(map[string]interface{}); ok {
			if v, ok := meta["lastTouchedVersion"].(string); ok && v != "" {
				return v
			}
		}
	}

	// 3. Try npm global: read package.json from npm root
	npmRoot := detectCmd("npm", "root", "-g")
	if npmRoot != "" {
		pkgPath := filepath.Join(npmRoot, "openclaw", "package.json")
		if v := readVersionFromPackageJSON(pkgPath); v != "" {
			return v
		}
	}

	// 4. Try common binary paths
	commonPaths := []string{
		"/usr/local/bin/openclaw",
		"/usr/bin/openclaw",
		filepath.Join(os.Getenv("HOME"), ".local/bin/openclaw"),
		filepath.Join(os.Getenv("HOME"), ".npm-global/bin/openclaw"),
	}
	for _, p := range commonPaths {
		if _, err := os.Stat(p); err == nil {
			out := detectCmd(p, "--version")
			if out != "" {
				return strings.TrimPrefix(strings.TrimSpace(out), "v")
			}
		}
	}

	// 5. Try source installs: check common directories for package.json
	sourcePaths := []string{
		filepath.Join(os.Getenv("HOME"), "openclaw"),
		filepath.Join(os.Getenv("HOME"), "openclaw/app"),
		"/opt/openclaw",
		"/usr/lib/node_modules/openclaw",
	}
	for _, sp := range sourcePaths {
		pkgPath := filepath.Join(sp, "package.json")
		if v := readVersionFromPackageJSON(pkgPath); v != "" {
			return v
		}
	}

	// 6. Try Docker container
	dockerVer := detectCmd("docker", "exec", "openclaw", "openclaw", "--version")
	if dockerVer != "" {
		return strings.TrimPrefix(strings.TrimSpace(dockerVer), "v")
	}

	// 7. Try systemd: parse ExecStart from service file to find binary path
	svcContent := detectCmd("systemctl", "cat", "openclaw")
	if svcContent != "" {
		for _, line := range strings.Split(svcContent, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "ExecStart=") {
				parts := strings.Fields(strings.TrimPrefix(line, "ExecStart="))
				if len(parts) > 0 {
					bin := parts[0]
					out := detectCmd(bin, "--version")
					if out != "" {
						return strings.TrimPrefix(strings.TrimSpace(out), "v")
					}
				}
				break
			}
		}
	}

	// 8. Config file exists but no version extractable
	if ocConfig != nil {
		return "installed"
	}

	return ""
}

// readVersionFromPackageJSON reads the "version" field from a package.json file
func readVersionFromPackageJSON(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var pkg map[string]interface{}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return ""
	}
	if v, ok := pkg["version"].(string); ok && v != "" {
		return v
	}
	return ""
}

// DetectOpenClawInstances 检测所有 OpenClaw 安装实例
func DetectOpenClawInstances(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		var instances []OpenClawInstance

		// 1. npm global install
		npmPath := detectCmd("which", "openclaw")
		if npmPath != "" {
			ver := detectCmd("openclaw", "--version")
			instances = append(instances, OpenClawInstance{
				ID: "npm-global", Type: "npm", Label: "npm 全局安装",
				Version: ver, Path: npmPath, Active: true, Status: "installed",
			})
		}

		// 2. systemd service
		systemdOut := detectCmd("systemctl", "is-active", "openclaw")
		if systemdOut == "active" || systemdOut == "inactive" {
			ver := ""
			if ocConfig, _ := cfg.ReadOpenClawJSON(); ocConfig != nil {
				if meta, ok := ocConfig["meta"].(map[string]interface{}); ok {
					ver, _ = meta["lastTouchedVersion"].(string)
				}
			}
			instances = append(instances, OpenClawInstance{
				ID: "systemd", Type: "systemd", Label: "systemd 服务",
				Version: ver, Active: systemdOut == "active", Status: systemdOut,
			})
		}

		// 3. Docker container
		dockerOut := detectCmd("docker", "ps", "-a", "--filter", "name=openclaw", "--format", "{{.Names}}|{{.Status}}|{{.Image}}")
		if dockerOut != "" {
			for _, line := range strings.Split(dockerOut, "\n") {
				parts := strings.SplitN(line, "|", 3)
				if len(parts) >= 2 {
					name := parts[0]
					status := parts[1]
					image := ""
					if len(parts) >= 3 {
						image = parts[2]
					}
					// Skip our management containers
					if name == "openclaw-qq" || name == "openclaw-wechat" {
						continue
					}
					running := strings.HasPrefix(status, "Up")
					instances = append(instances, OpenClawInstance{
						ID: "docker-" + name, Type: "docker", Label: "Docker: " + name,
						Version: image, Path: name, Active: running,
						Status: func() string { if running { return "running" }; return "stopped" }(),
					})
				}
			}
		}

		// 4. Source code install (check common paths)
		sourcePaths := []string{
			filepath.Join(os.Getenv("HOME"), "openclaw"),
			"/opt/openclaw",
		}
		for _, sp := range sourcePaths {
			pkgPath := filepath.Join(sp, "package.json")
			if _, err := os.Stat(pkgPath); err == nil {
				var pkg map[string]interface{}
				if data, err := os.ReadFile(pkgPath); err == nil {
					json.Unmarshal(data, &pkg)
				}
				ver, _ := pkg["version"].(string)
				instances = append(instances, OpenClawInstance{
					ID: "source-" + sp, Type: "source", Label: "源码: " + sp,
					Version: ver, Path: sp, Active: false, Status: "installed",
				})
			}
		}

		c.JSON(http.StatusOK, gin.H{"ok": true, "instances": instances})
	}
}

// InstallSoftware 一键安装软件
func InstallSoftware(cfg *config.Config, tm *taskman.Manager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Software string `json:"software"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.Software == "" {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "software required"})
			return
		}

		if tm.HasRunningTask("install_" + req.Software) {
			c.JSON(http.StatusConflict, gin.H{"ok": false, "error": "该软件正在安装中"})
			return
		}

		// Read sudo password
		sudoPass := ""
		if sp := getSudoPass(cfg); sp != "" {
			sudoPass = sp
		}

		var script string
		var taskName string

		switch req.Software {
		case "nodejs":
			taskName = "安装 Node.js"
			script = `
set -e
echo "📦 安装 Node.js (v22 LTS)..."
if command -v node &>/dev/null; then
  echo "⚠️ Node.js 已安装: $(node --version)"
  echo "正在更新..."
fi
# Use NodeSource for China-friendly install
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
# Set npm mirror
npm config set registry https://registry.npmmirror.com
echo "✅ Node.js $(node --version) 安装完成"
echo "✅ npm $(npm --version)"
`
		case "docker":
			taskName = "安装 Docker"
			script = `
set -e
echo "📦 安装 Docker..."
if command -v docker &>/dev/null; then
  echo "⚠️ Docker 已安装: $(docker --version)"
  exit 0
fi
# Use Aliyun mirror
curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg 2>/dev/null || true
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
# Configure Docker mirror
mkdir -p /etc/docker
cat > /etc/docker/daemon.json << 'DOCKEREOF'
{
  "registry-mirrors": [
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me"
  ]
}
DOCKEREOF
systemctl enable docker
systemctl restart docker
echo "✅ Docker $(docker --version) 安装完成"
`
		case "git":
			taskName = "安装 Git"
			script = `
set -e
echo "📦 安装 Git..."
apt-get update
apt-get install -y git
echo "✅ $(git --version) 安装完成"
`
		case "python":
			taskName = "安装 Python 3"
			script = `
set -e
echo "📦 安装 Python 3..."
apt-get update
apt-get install -y python3 python3-pip python3-venv
# Set pip mirror
pip3 config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple 2>/dev/null || true
echo "✅ $(python3 --version) 安装完成"
`
		case "openclaw":
			taskName = "安装 OpenClaw"
			script = `
set -e
echo "📦 安装 OpenClaw..."
if ! command -v node &>/dev/null; then
  echo "❌ 需要先安装 Node.js"
  exit 1
fi
npm install -g openclaw@latest --registry=https://registry.npmmirror.com
echo "✅ OpenClaw $(openclaw --version) 安装完成"
echo "📝 初始化配置..."
openclaw init 2>/dev/null || true
`
		case "napcat":
			taskName = "安装 NapCat (QQ个人号)"
			script = buildNapCatInstallScript(cfg)

		case "wechat":
			taskName = "安装微信机器人"
			script = buildWeChatInstallScript(cfg)

		default:
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "不支持的软件: " + req.Software})
			return
		}

		task := tm.CreateTask(taskName, "install_"+req.Software)

		go func() {
			var err error
			if sudoPass != "" && req.Software != "openclaw" {
				// Most installs need sudo
				err = tm.RunScriptWithSudo(task, sudoPass, script)
			} else {
				err = tm.RunScript(task, script)
			}
			tm.FinishTask(task, err)
		}()

		c.JSON(http.StatusOK, gin.H{"ok": true, "taskId": task.ID})
	}
}

// GetTasks 获取任务列表
func GetTasks(tm *taskman.Manager) gin.HandlerFunc {
	return func(c *gin.Context) {
		tasks := tm.GetRecentTasks()
		c.JSON(http.StatusOK, gin.H{"ok": true, "tasks": tasks})
	}
}

// GetTaskDetail 获取任务详情
func GetTaskDetail(tm *taskman.Manager) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		task := tm.GetTask(id)
		if task == nil {
			c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "任务不存在"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "task": task})
	}
}

func getSudoPass(cfg *config.Config) string {
	spPath := filepath.Join(cfg.DataDir, "sudo-password.txt")
	data, err := os.ReadFile(spPath)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func buildNapCatInstallScript(cfg *config.Config) string {
	return fmt.Sprintf(`
set -e
echo "📦 安装 NapCat (QQ个人号) Docker 容器..."

if ! command -v docker &>/dev/null; then
  echo "❌ 需要先安装 Docker"
  exit 1
fi

# Check if already exists
if docker inspect openclaw-qq &>/dev/null; then
  echo "⚠️ openclaw-qq 容器已存在，正在重新创建..."
  docker stop openclaw-qq 2>/dev/null || true
  docker rm openclaw-qq 2>/dev/null || true
fi

echo "📥 拉取 NapCat 镜像..."
docker pull mlikiowa/napcat-docker:latest

echo "🔧 创建容器..."
docker run -d \
  --name openclaw-qq \
  --restart unless-stopped \
  -p 3000:3000 \
  -p 3001:3001 \
  -p 6099:6099 \
  -e NAPCAT_GID=0 \
  -e NAPCAT_UID=0 \
  -e WEBUI_TOKEN=clawpanel-qq \
  -v napcat-qq-session:/app/.config/QQ \
  -v napcat-config:/app/napcat/config \
  -v %s:/root/.openclaw:rw \
  -v %s:/root/openclaw/work:rw \
  mlikiowa/napcat-docker:latest

echo "⏳ 等待容器启动..."
sleep 5

# Configure OneBot11 WebSocket + HTTP
echo "🔧 配置 OneBot11 (WS + HTTP)..."
docker exec openclaw-qq bash -c 'cat > /app/napcat/config/onebot11.json << OBEOF
{
  "network": {
    "websocketServers": [{
      "name": "ws-server",
      "enable": true,
      "host": "0.0.0.0",
      "port": 3001,
      "token": "",
      "reportSelfMessage": true,
      "enableForcePushEvent": true,
      "messagePostFormat": "array",
      "debug": false,
      "heartInterval": 30000
    }],
    "httpServers": [{
      "name": "http-api",
      "enable": true,
      "host": "0.0.0.0",
      "port": 3000,
      "token": ""
    }],
    "httpSseServers": [],
    "httpClients": [],
    "websocketClients": [],
    "plugins": []
  },
  "musicSignUrl": "",
  "enableLocalFile2Url": true,
  "parseMultMsg": true,
  "imageDownloadProxy": ""
}
OBEOF'

# Configure WebUI
docker exec openclaw-qq bash -c 'cat > /app/napcat/config/webui.json << WUEOF
{
  "host": "0.0.0.0",
  "port": 6099,
  "token": "clawpanel-qq",
  "loginRate": 3
}
WUEOF'

echo "✅ NapCat (QQ个人号) 安装完成"
echo "📝 请在通道管理中配置 QQ 并扫码登录"
`, cfg.OpenClawDir, cfg.OpenClawWork)
}

func buildWeChatInstallScript(cfg *config.Config) string {
	return `
set -e
echo "📦 安装微信机器人 Docker 容器..."

if ! command -v docker &>/dev/null; then
  echo "❌ 需要先安装 Docker"
  exit 1
fi

# Check if already exists
if docker inspect openclaw-wechat &>/dev/null; then
  echo "⚠️ openclaw-wechat 容器已存在，正在重新创建..."
  docker stop openclaw-wechat 2>/dev/null || true
  docker rm openclaw-wechat 2>/dev/null || true
fi

echo "📥 拉取 wechatbot-webhook 镜像..."
docker pull dannicool/docker-wechatbot-webhook:latest

echo "🔧 创建容器..."
docker run -d \
  --name openclaw-wechat \
  --restart unless-stopped \
  -p 3002:3001 \
  -e LOGIN_API_TOKEN=clawpanel-wechat \
  -e RECVD_MSG_API=http://host.docker.internal:19527/api/wechat/callback \
  -e ACCEPT_RECVD_MSG_MYSELF=false \
  -e LOG_LEVEL=info \
  -v wechat-data:/app/data \
  --add-host=host.docker.internal:host-gateway \
  dannicool/docker-wechatbot-webhook:latest

echo "⏳ 等待容器启动..."
sleep 3

echo "✅ 微信机器人安装完成"
echo "📝 请在通道管理中配置微信并扫码登录"
`
}
