# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的格式。

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
