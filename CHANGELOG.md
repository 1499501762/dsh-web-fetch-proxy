# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的格式。

## [0.2.0] - 2026-09-17

### 新增

- **配置页面**：注册 `web-fetch-proxy` settings 命名空间（`applies: live`），在
  **设置 → 常规** 里提供「自动检测 / 手动代理 / 关闭」、代理地址、绕过列表与实时状态行，
  改动立即生效，无需重启。
- **状态接口**：`POST /web-fetch-proxy/api`，带同源围栏（仅接受 loopback / 受信 Host），
  返回当前路由、来源与失败原因，并支持 `redetect` 重新探测。
- **路由生命周期管理器**（`lib/manager.js`）：代际保护（慢探测不会覆盖更新的配置）、
  可唤醒的重试等待、路由释放与状态快照。

### 变更

- 插件现在声明 `dsh.client`，宿主据此加载设置页（`exports["./client"]`）。
- 宿主包解析新增同步入口 `requireHarnessModule`，用于在 cordis inject 回调内加载 settings schema。

## [0.1.0] - 2026-09-17

### 新增

- 自动发现本地 HTTP 代理：显式配置 → 环境变量 → Clash/Mihomo 配置的
  mixed-port → Windows WinINET 系统代理 → 常见端口 TCP 探测。
- 通过 @deepseek-ai/dsh-http-proxy 的 installProxyFromEnvironment() 安装宿主
  级代理策略，使 @deepseek-ai/dsh-web-fetch-http 走 proxied 路由，跳过本地
  DNS 校验。
- 宿主模块解析锚定在 harness 目录树内，支持从 harness 树外以 link: 方式安装。
- 探测失败时按 retryMs / maxRetries 重试，代理客户端晚启动也能自愈。
- 全部失败路径 fail-open：不抛错、不覆盖已有路由、代理不可达则不安装。
