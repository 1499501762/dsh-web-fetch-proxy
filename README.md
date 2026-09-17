# dsh-web-fetch-proxy

> DSH 插件：让内置 `web_fetch` 经由本地代理出网，绕过 TUN 模式下 fake-ip 假地址被 SSRF 防护拦截的问题。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## 症状

在开着 TUN 模式代理（Clash Verge / Mihomo、sing-box、Surge 等）的 Windows 上，DSH 的 `web_fetch` 对所有域名都失败，
报错形如：

```
### https://raw.githubusercontent.com/... -> ERROR URL hostname "raw.githubusercontent.com" resolves to a non-public IP address
```

关键点是：**DNS 解析成功了**。失败的原因不是解析不了，而是解析出来的地址被判定为**非公网地址**从而被主动拦截。

## 根因

### 1. TUN + fake-ip 会返回假地址

Clash Verge Rev 的运行时配置（`%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\config.yaml`）里：

```yaml
mixed-port: 7897
tun:
  enable: true
  dns-hijack: [any:53]
```

而它的 DNS 覆盖层设置了 fake-ip：

```yaml
dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-range: 28.0.0.1/8
  fake-ip-range6: fdfe:dcba:9876::1/64
```

于是系统 DNS 被 53 端口劫持后，任何域名都会得到伪造地址：

```
raw.githubusercontent.com  A     28.0.0.250
raw.githubusercontent.com  AAAA  fdfe:dcba:9876::ed
DNS 服务器地址:                  fdfe:dcba:9876::2
```

这是 fake-ip 模式的正常行为：故意返回假 IP，才能在 TLS 之前按域名分流。

### 2. web_fetch 的 SSRF 防护会拒绝这类地址

`@deepseek-ai/dsh-web-fetch-http` 在建立连接之前先自己解析域名，并逐条校验：

```js
// node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js
const resolved = await resolver(hostname, { all: true, order: "verbatim" });
for (const entry of resolved) {
  if (!isPublicIpAddress(entry.address))
    throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, "WEB_BLOCKED_URL");
}
```

`isPublicIpAddress` 用 `ipaddr.js` 判定，实测结果：

```
28.0.0.250           ipv4  unicast      通过
fdfe:dcba:9876::ed   ipv6  uniqueLocal  拒绝   <- fc00::/7，不是公网单播
```

因为查询用的是 `all: true`（同时拿 A 和 AAAA），而循环是「只要有一条不合格就整体拒绝」（防 DNS rebinding），
所以只要有 AAAA 记录（现在几乎所有站点都有），请求就必然失败——连接从未发出。

### 3. 为什么普通代理插件救不了

`web_fetch` 是否走代理，取决于 `@deepseek-ai/dsh-http-proxy` 的进程级策略：

```js
// dsh-web-fetch-http/lib/index.js:501
const route = proxyRouteFor(url);
if (route.proxied && !isNonPublicIpLiteral(url.hostname))
  return await publicHttpNetwork.requestVia(route.dispatcher, url, headers, signal);
// 否则：本地解析 + 公网校验
```

这条 `route` 只由 `installProxyFromEnvironment()` 在**启动时从环境变量**解析并安装。
插件（例如 `dsh-network-proxy`）即使用 `undici.setGlobalDispatcher()` 接管了全局 Dispatcher，
`dsh-http-proxy` 内部的 `active` 策略仍然是空的，`proxyRouteFor()` 依旧返回 `{ proxied: false }`，
`web_fetch` 还是走本地 DNS 校验。

实测（本仓库 `npm run verify` 的对照输出）：

```
route before  : direct (local DNS check applies)
fetch before  : WEB_BLOCKED_URL URL hostname "raw.githubusercontent.com" resolves to a non-public IP address
```

## 这个插件做什么

启动时在宿主进程内：

1. 找到当前可用的本地 HTTP 代理（见下方发现顺序）；
2. 用一份合成的 launch environment 调用 `@deepseek-ai/dsh-http-proxy` 的 `installProxyFromEnvironment()`，
   为整个进程安装一条 proxied 策略；
3. 校验 `proxyRouteFor()` 确实变为 `proxied: true`，否则立刻回滚。

于是 `web_fetch` 走代理隧道，由代理侧解析域名，**跳过本地 DNS 校验**：

```
route after   : proxied via http://127.0.0.1:7897
fetch after   : ok, 200, 1046 chars
```

全程不需要重启时环境变量，也不需要改动代理客户端。

## 安装

### 本地目录（开发 / 私有插件）

```bash
git clone https://github.com/1499501762/dsh-web-fetch-proxy.git
dsh plugin --profile web add link:<仓库绝对路径>
```

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:1499501762/dsh-web-fetch-proxy
```

安装后重启 DSH。启动日志里出现下面这行就说明生效了：

```
[web-fetch-proxy] web_fetch now tunnels through http://127.0.0.1:7897 (source: clash-config:...); the local DNS check is bypassed.
```

> 注意：本插件的 `cordis.patch.yml` 已经声明了插入行，`dsh plugin add` 会把它写进 profile 的 bundles。
> 如果你的 profile 是手动维护的，也可以自己在 `<DSH_HOME>/profiles/web/cordis.patch.yml` 里加：
>
> ```yaml
> - insert:
>     - id: web-fetch-proxy
>       name: dsh-web-fetch-proxy
> ```

## 配置

全部字段可选，写在 `cordis.patch.yml` 的 `config` 里：

```yaml
- insert:
    - id: web-fetch-proxy
      name: dsh-web-fetch-proxy
      config:
        enabled: true        # false 则完全不介入
        proxy: auto          # auto | off | http://host:port | host:port
        noProxy: ""          # 额外的不走代理的域名，逗号分隔
        retryMs: 15000       # 自动发现失败后的重试间隔，0 = 不重试
        maxRetries: 20       # 最大重试次数
        probeTimeoutMs: 400  # 单个候选代理的 TCP 探测超时
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | `false` 时插件不安装任何路由 |
| `proxy` | string | `auto` | `auto` 自动发现；`off`/`none`/`direct` 不安装；也可以直接写死代理地址 |
| `noProxy` | string | `""` | 追加到绕过列表（`localhost`、`127.0.0.1`、`::1` 由 dsh-http-proxy 强制绕过） |
| `retryMs` | number | `15000` | 代理客户端比 DSH 晚启动时，按此间隔重试 |
| `maxRetries` | number | `20` | 重试上限（约 5 分钟） |
| `probeTimeoutMs` | number | `400` | 候选代理的 TCP 连接超时 |

也可以直接用环境变量指定，优先级高于自动发现：

```bash
set DSH_WEB_FETCH_PROXY=http://127.0.0.1:7897
```

## 代理发现顺序

`proxy: auto` 时按以下顺序找第一个**当前能建立 TCP 连接**的候选：

1. `DSH_WEB_FETCH_PROXY` 环境变量；
2. `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` / `ALL_PROXY` / `all_proxy`；
3. 本地 Clash / Mihomo / Clash Verge 配置里的 `mixed-port`
   （`%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\config.yaml` 等 8 个已知路径）；
4. Windows WinINET 系统代理（`HKCU\...\Internet Settings`，即系统代理开关打开时的设置）；
5. 常见端口 TCP 探测：7897、7890、7891、7899、10809、10808、1080、2080、20171、8889。

任何候选都必须先通过 TCP 探测，避免把路由指向一个没在运行的代理。

## 与 dsh-network-proxy 的关系

`dsh-network-proxy` 管的是**全局 undici Dispatcher**（跟随系统 / 手动 / 直连），它能让普通 `fetch` 走代理，
但它没有触及 `@deepseek-ai/dsh-http-proxy` 的策略，所以 `web_fetch` 不受其影响。

**两者不冲突。** 把两个插件装进同一个进程实测的结果：

| 场景 | `proxyRouteFor()` | `web_fetch` |
| --- | --- | --- |
| 只装 `dsh-network-proxy`（直连模式） | DIRECT | 失败 `WEB_BLOCKED_URL` |
| 再挂上本插件 | PROXIED `127.0.0.1:7897` | 200 |
| `dsh-network-proxy` 经 settings 切到「手动」 | PROXIED | 200 |
| `dsh-network-proxy` 切到「直连」（清空 `HTTP(S)_PROXY`） | PROXIED | 200 |
| 连续来回切换三次 | PROXIED | 每次都是 200 |

要点：

- `web_fetch` 只认 `dsh-http-proxy` 自己持有的策略与 dispatcher，别的插件 `setGlobalDispatcher()` 改不动它
  ——实测 `dsh-network-proxy` 把 `HTTPS_PROXY` 清空后，`web_fetch` 照样走隧道；
- 两者确实共用 **undici 全局 Dispatcher**（后写者赢），但这只影响普通 `fetch()`（模型 API、其它插件），不影响 `web_fetch`；
- 两者都只关闭自己创建的 dispatcher，所以反复切换模式不会把对方弄坏；
- 唯一会让人困惑的是：`dsh-network-proxy` 的「直连 / 手动 / 跟随系统」**不管辖 `web_fetch`**。
  若把它设为「直连」，普通请求直连而 `web_fetch` 仍走代理，界面上会显得不一致。要让两条路径一致，
  就把它们指向同一个代理，或在本插件的 `config.proxy` 里写死同一个地址。

## 安全性

- **fail-open**：模块求值期不抛错，`apply()` 不抛错，异步流程只在 logger 里报告失败；
- 不覆盖宿主已有的代理路由（启动时若 `proxyRouteFor()` 已经是 proxied，直接退出）；
- 只使用 `node:` 内置模块做静态导入，宿主包全部用动态 `import()` 包在 try/catch 里，
  即使某个 DSH 版本改了内部结构，也不会阻止宿主启动；
- 安装后会用 `proxyRouteFor()` 自检，不生效就回滚。

### 为什么需要「锚定解析」

插件通常以 `link:` 方式从 harness 目录树之外安装，此时它的真实路径在 `profiles/` 之外，
裸 `import("@deepseek-ai/dsh-http-proxy")` 会 `ERR_MODULE_NOT_FOUND`。
本插件会按 `DSH_HOME`、app 安装目录、`cwd` 依次构造解析锚点，用 `createRequire(anchor).resolve()` 定位宿主包。
Node 的 ES 模块按 realpath 去重，因此通过锚点拿到的实例与 `dsh-web-fetch-http` 内部用的是**同一个模块实例**
（`bare === anchored === junction === appCopy` 的恒等性已验证）。

## 验证

```bash
npm test            # 17 个单元 / 集成测试
npm run verify      # 对真实网址做前后对照，打印 route 与 HTTP 状态码
npm run verify -- https://example.com/
```

`npm run verify` 会在独立进程里跑真实的 `HttpFetchProvider`，安装前后各取一次，
不改动正在运行的 DSH。

## 目录结构

```
dsh-web-fetch-proxy/
├── lib/index.js          # cordis 宿主插件：配置、安装、自检、重试、生命周期
├── lib/detect.js         # 代理发现（环境变量 / Clash 配置 / 系统代理 / 端口探测）
├── lib/harness.js        # 宿主模块的锚定解析与 launch environment 构造
├── scripts/verify.mjs    # 真实网络的前后对照验证脚本
├── test/                 # node:test 测试
├── cordis.patch.yml      # 插件注入声明
└── package.json
```

## 常见问题

**Q: 装完之后 `web_fetch` 还是失败？**

A: 看启动日志。如果是 `no reachable local proxy found`，说明插件没找到代理：确认代理客户端已启动并监听
（Clash Verge 默认 `mixed-port: 7897`），或者用 `DSH_WEB_FETCH_PROXY` 显式指定。
如果是 `cannot reach the harness network modules`，说明 DSH 版本差异导致内部包路径变了，欢迎提 issue。

**Q: 会不会影响模型 API 的请求？**

A: 进程级策略会对所有出站 HTTP 生效，模型 API 的流量也会经过本地代理，由代理客户端按自己的规则分流。
如果你希望某些域名直连，用 `noProxy` 或代理客户端的规则处理。

**Q: 关掉代理客户端后 DSH 会断网吗？**

A: 不会。插件只在探测到代理可连接时才安装路由；代理中途退出属于运行期变化，
此时出站请求会失败，重启 DSH 或重新触发（插件会重试）即可恢复直连。

**Q: 支持 SOCKS 代理吗？**

A: 不支持。`dsh-http-proxy` 只接受 `http(s)://`，本插件与之保持一致；Clash 的 `mixed-port` 本身就是 HTTP 混合端口。

## License

[MIT](./LICENSE) © 2026 Tong317
