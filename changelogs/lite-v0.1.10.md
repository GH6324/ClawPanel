# ClawPanel Lite v0.1.10

发布时间：2026-03-13

## Linux Fresh Install 修复

- 修复 fresh Linux Lite 安装后 `OpenClaw 与网关均离线` 的问题
- 默认写入 `plugins.slots.memory = "none"`，避免 `memory-core` 缺失时配置校验直接失败
- Lite 服务默认增加 `NODE_OPTIONS=--max-old-space-size=2048`，降低 gateway 在服务器环境下 OOM 退出的概率

## 发布同步补强

- Gitee Release 资产上传增加重试逻辑
- 单个大文件上传失败不再阻断整个 Gitee Release 同步流程

## 当前说明

- Linux Lite 为当前正式推荐版本
- Windows / macOS Lite 继续保持预览验证阶段
