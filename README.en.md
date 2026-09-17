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

## Settings page

After a restart, **Settings -> General** shows a "Web Fetch proxy" row:

| Control | Effect |
| --- | --- |
| Auto-detect / Manual proxy / Off | Writes the `proxy` field of the `web-fetch-proxy` settings namespace; applies **live**, no restart |
| Proxy URL input | Manual mode; accepts `http://127.0.0.1:7897` or `127.0.0.1:7897`. The host validates and rejects bad values before they are stored |
| Bypass list | Appends `noProxy` entries; `localhost`, `127.0.0.1` and `::1` are always bypassed by dsh-http-proxy |
| Status line / Re-detect | Reads the host's live status (current route, source, failure reason) and can re-run discovery on demand |

The status line reports what the host actually did, for example:

```
Active  http://127.0.0.1:7897  (via: clash-config:...)
```

It reads a fenced, loopback-only endpoint, `POST /web-fetch-proxy/api`
(`{"action":"status"}` to read, `{"action":"redetect"}` to re-run discovery).

> There is no "restart to apply" step: the settings namespace is `applies: live`, and the host
> rebuilds the route from `scope.watch()` - the previous policy is released first, then discovery
> and installation run again with the new configuration.

## Configuration (cordis layer)

The page writes the same configuration. The `config` block in `cordis.patch.yml` supplies the
deployment baseline and defaults (the settings `base` layer), and carries the fields the page
does not expose:

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

## Coexistence with dsh-network-proxy

They do not conflict. Measured with both plugins mounted in one process:

| Situation | `proxyRouteFor()` | `web_fetch` |
| --- | --- | --- |
| only `dsh-network-proxy` (direct mode) | DIRECT | fails with `WEB_BLOCKED_URL` |
| plus this plugin | PROXIED `127.0.0.1:7897` | 200 |
| `dsh-network-proxy` switched to manual via its settings watcher | PROXIED | 200 |
| `dsh-network-proxy` switched to direct (clears `HTTP(S)_PROXY`) | PROXIED | 200 |
| three mode flips in a row | PROXIED | 200 every time |

- `web_fetch` only consults the policy and dispatcher held by `dsh-http-proxy`; `setGlobalDispatcher()`
  from another plugin cannot take it away.
- Both share the undici global dispatcher (last writer wins), which affects plain `fetch()` only.
- Neither closes a dispatcher it did not create, so repeated mode changes are safe.
- The only oddity: the `direct` / `manual` / `system` setting of `dsh-network-proxy` does not govern
  `web_fetch`. Point both at the same proxy to keep them consistent.

## Safety

- Fail-open: no throw during module evaluation, none from `apply()`, and no route is installed unless
  the proxy is actually accepting connections.
- An existing host route is never overridden.
- Only `node:` builtins are imported statically; harness packages are loaded through anchored,
  guarded imports (async for the proxy runtime, synchronous for the settings schema), so a harness
  layout change degrades the settings page instead of stopping the host from booting.
- Installation is self-checked with `proxyRouteFor()` and rolled back when it did not take.

## Verify

```bash
npm test            # unit and integration tests
npm run verify      # live before/after comparison against a real URL
```

Coverage: proxy discovery, anchored host-module resolution, route lifecycle (including the
"a slow discovery must not overwrite a newer configuration" generation guard), the settings and
status surfaces, and a real `HttpFetchProvider` before/after integration test.

`npm run verify` runs the real `HttpFetchProvider` in a separate process and never touches the
running harness.

## License

[MIT](./LICENSE) © 2026 Tong317
