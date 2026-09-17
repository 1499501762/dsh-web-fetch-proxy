# dsh-web-fetch-proxy

> A DSH plugin that routes the built-in `web_fetch` through a local proxy, so TUN-mode fake-ip
> answers stop tripping the provider SSRF guard.

## Symptom

On Windows with a TUN-mode proxy client running (Clash Verge / Mihomo, sing-box, Surge), every
`web_fetch` call fails:

```
ERROR URL hostname "raw.githubusercontent.com" resolves to a non-public IP address
```

DNS resolution succeeded. The address set was rejected by policy.

## Root cause

1. **fake-ip DNS.** Clash Verge Rev runs TUN mode with `dns.enhanced-mode: fake-ip`,
   `fake-ip-range: 28.0.0.1/8` and `fake-ip-range6: fdfe:dcba:9876::1/64`. Every name resolves
   to a synthetic address, for example `28.0.0.250` and `fdfe:dcba:9876::ed`.
2. **The SSRF guard.** `@deepseek-ai/dsh-web-fetch-http` resolves the hostname itself and rejects
   the whole answer set if any address is not globally routable unicast. `fdfe:dcba:9876::ed` sits in
   `fc00::/7`, so `ipaddr.js` reports `uniqueLocal` and throws `WEB_BLOCKED_URL`.
3. **The escape hatch the provider already has.** When `@deepseek-ai/dsh-http-proxy` reports a
   *proxied* route for the URL, the provider tunnels through it and lets the proxy resolve the
   hostname, skipping the local DNS check. That route only exists when the harness was launched
   with `HTTP(S)_PROXY` set.

A proxy plugin that only calls `undici.setGlobalDispatcher()` does not create that route: the
policy inside `dsh-http-proxy` stays empty, `proxyRouteFor()` keeps returning `{ proxied: false }`,
and `web_fetch` still resolves locally.

## What this plugin does

At boot, inside the host process, it:

1. finds a reachable local HTTP proxy;
2. calls `installProxyFromEnvironment()` from `@deepseek-ai/dsh-http-proxy` with a synthesized
   launch environment, installing a process-wide proxied policy;
3. verifies that `proxyRouteFor()` now reports `proxied: true`, and rolls back otherwise.

```
route before  : direct (local DNS check applies)
fetch before  : WEB_BLOCKED_URL URL hostname "raw.githubusercontent.com" resolves to a non-public IP address
route after   : proxied via http://127.0.0.1:7897
fetch after   : ok, 200, 1046 chars
```

## Install

```bash
dsh plugin --profile web add github:1499501762/dsh-web-fetch-proxy
# or, from a local checkout:
dsh plugin --profile web add link:<absolute-path-to-this-package>
```

Restart DSH. A working boot logs:

```
[web-fetch-proxy] web_fetch now tunnels through http://127.0.0.1:7897 (source: clash-config:...); the local DNS check is bypassed.
```

## Configuration

```yaml
- insert:
    - id: web-fetch-proxy
      name: dsh-web-fetch-proxy
      config:
        enabled: true        # false disables the plugin entirely
        proxy: auto          # auto | off | http://host:port | host:port
        noProxy: ""          # extra bypass entries, comma separated
        retryMs: 15000       # retry interval when nothing was found, 0 disables
        maxRetries: 20
        probeTimeoutMs: 400
```

`DSH_WEB_FETCH_PROXY` overrides auto-detection.

## Discovery order

With `proxy: auto`, the first candidate that accepts a TCP connection wins:

1. `DSH_WEB_FETCH_PROXY`
2. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` (either casing)
3. the `mixed-port` in a local Clash / Mihomo / Clash Verge config (8 known paths)
4. the Windows WinINET system proxy (`HKCU\...\Internet Settings`)
5. a TCP probe of well-known ports: 7897, 7890, 7891, 7899, 10809, 10808, 1080, 2080, 20171, 8889

## Safety

- Fail-open: no throw during module evaluation, none from `apply()`, and no route is installed unless
  the proxy is actually accepting connections.
- An existing host route is never overridden.
- Only `node:` builtins are imported statically; harness packages are loaded through guarded dynamic
  imports, so a harness layout change can never stop the host from booting.
- Installation is self-checked with `proxyRouteFor()` and rolled back when it did not take.

## Verify

```bash
npm test            # unit and integration tests
npm run verify      # live before/after comparison against a real URL
```

`npm run verify` runs the real `HttpFetchProvider` in a separate process and never touches the
running harness.

## License

[MIT](./LICENSE) © 2026 Tong317
