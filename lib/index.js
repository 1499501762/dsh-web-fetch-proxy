/**
 * dsh-web-fetch-proxy - host half.
 *
 * WHY THIS EXISTS
 * ---------------
 * The harness's built-in web_fetch provider (@deepseek-ai/dsh-web-fetch-http)
 * has an SSRF guard: it resolves the target hostname itself and refuses the whole
 * answer set when any address is not globally routable unicast. A TUN-mode proxy
 * client (Clash Verge / Mihomo, sing-box, Surge) with DNS "fake-ip" answers every
 * name with a synthetic address, e.g.
 *
 *     raw.githubusercontent.com -> 28.0.0.250, fdfe:dcba:9876::ed
 *
 * The IPv6 answer lives in fc00::/7 (unique local), so ipaddr.js classifies it as
 * "uniqueLocal" instead of "unicast" and the fetch dies with
 *
 *     WEB_BLOCKED_URL URL hostname "..." resolves to a non-public IP address
 *
 * The provider already knows the way out: when @deepseek-ai/dsh-http-proxy reports
 * a proxied route for the URL, the provider tunnels through that route and lets the
 * proxy resolve the hostname, skipping the local DNS check entirely. That route only
 * exists when the harness was launched with HTTP(S)_PROXY set.
 *
 * This plugin closes that gap: at boot it finds the local proxy, installs a policy
 * into @deepseek-ai/dsh-http-proxy, and web_fetch starts working - no restart-time
 * environment variables, no changes to the proxy client.
 *
 * SAFETY
 * ------
 * The plugin is deliberately fail-open. It never throws during module evaluation,
 * never throws from apply(), never overrides an existing route, and only installs a
 * policy for a proxy that currently accepts a TCP connection. If anything at all
 * goes wrong, the harness keeps its previous behaviour.
 *
 * @module dsh-web-fetch-proxy
 */
import { discoverProxy } from "./detect.js";
import { loadHarness } from "./harness.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-fetch-proxy";

const DEFAULT_RETRY_MS = 15000;
const DEFAULT_MAX_RETRIES = 20;
const DEFAULT_PROBE_TIMEOUT_MS = 400;

/** Config values that mean "do not install a route". */
const DISABLED_VALUES = ["off", "none", "direct", "disable", "disabled", "false"];

/** Normalize the cordis config object; every field is optional. */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const proxy = typeof source.proxy === "string" && source.proxy.trim() !== "" ? source.proxy.trim() : "auto";
  return {
    enabled: source.enabled !== false,
    proxy,
    noProxy: typeof source.noProxy === "string" ? source.noProxy.trim() : "",
    retryMs: Number.isFinite(source.retryMs) ? Math.max(0, Math.trunc(source.retryMs)) : DEFAULT_RETRY_MS,
    maxRetries: Number.isFinite(source.maxRetries) ? Math.max(0, Math.trunc(source.maxRetries)) : DEFAULT_MAX_RETRIES,
    probeTimeoutMs: Number.isFinite(source.probeTimeoutMs) ? Math.max(50, Math.trunc(source.probeTimeoutMs)) : DEFAULT_PROBE_TIMEOUT_MS,
  };
}

/** A logger that never throws and works with or without a cordis context. */
export function makeLogger(ctx) {
  const logger = ctx !== null && typeof ctx === "object" ? ctx.logger : undefined;
  return function log(level, message) {
    const line = "[" + name + "] " + message;
    try {
      if (logger !== undefined && logger !== null && typeof logger[level] === "function") {
        logger[level](line);
        return;
      }
      if (level === "warn" || level === "error") console.warn(line);
      else console.log(line);
    } catch {
      /* logging must never break the boot */
    }
  };
}

function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The policy target the route check uses; any public origin behaves the same. */
function routeProbeUrl() {
  return new URL("https://example.com/");
}

/**
 * Install one proxy policy and confirm the provider would actually take the tunnel.
 * @returns { dispose, url, source } on success, undefined when the policy did not take.
 */
async function installRoute(harness, hit, config, log) {
  const values = { http_proxy: hit.url, https_proxy: hit.url };
  const bypass = [];
  if (config.noProxy !== "") bypass.push(config.noProxy);
  if (typeof process.env.NO_PROXY === "string" && process.env.NO_PROXY.trim() !== "") bypass.push(process.env.NO_PROXY.trim());
  if (typeof process.env.no_proxy === "string" && process.env.no_proxy.trim() !== "") bypass.push(process.env.no_proxy.trim());
  if (bypass.length > 0) values.no_proxy = bypass.join(",");

  const environment = harness.createSnapshot([{ source: "process", values }]);
  const diagnostics = [];
  const dispose = await harness.proxy.installProxyFromEnvironment(environment, (message) => diagnostics.push(String(message)));
  for (const message of diagnostics) log("warn", "proxy policy diagnostic: " + message);

  const route = harness.proxy.proxyRouteFor(routeProbeUrl());
  if (route === undefined || route.proxied !== true) {
    try {
      await dispose();
    } catch {
      /* the rollback is best effort */
    }
    return undefined;
  }
  return { dispose, url: hit.url, source: hit.source };
}

/**
 * Find a proxy, install the route, and retry while the proxy client is still starting.
 * @param ctx - cordis context (only used for logging).
 * @param rawConfig - the plugin config from the profile patch.
 * @param state - mutable lifecycle record; state.dispose receives the disposer.
 * @param logger - optional logger override, mainly for tests.
 */
export async function run(ctx, rawConfig, state, logger) {
  const log = typeof logger === "function" ? logger : makeLogger(ctx);
  const config = resolveConfig(rawConfig);

  if (config.enabled !== true) {
    log("info", "disabled by config (enabled: false).");
    return { installed: false };
  }
  if (DISABLED_VALUES.indexOf(config.proxy.toLowerCase()) >= 0) {
    log("info", "proxy is set to " + config.proxy + "; no route installed.");
    return { installed: false };
  }

  const harness = await loadHarness(process.env);
  if (harness.ok !== true) {
    log("warn", "cannot reach the harness network modules (" + harness.reason + "); leaving the host untouched.");
    return { installed: false, reason: harness.reason };
  }

  const existing = harness.proxy.proxyRouteFor(routeProbeUrl());
  if (existing !== undefined && existing.proxied === true) {
    log("info", "the host already has a proxied route; web_fetch needs no change.");
    return { installed: false, alreadyProxied: true };
  }

  let attempt = 0;
  for (;;) {
    if (state !== undefined && state.stopped === true) return { installed: false, stopped: true };

    let hit;
    try {
      hit = await discoverProxy({ explicit: config.proxy, probeTimeoutMs: config.probeTimeoutMs });
    } catch (error) {
      log("warn", "proxy discovery failed: " + describe(error));
      hit = undefined;
    }

    if (hit !== undefined) {
      let installed;
      try {
        installed = await installRoute(harness, hit, config, log);
      } catch (error) {
        log("warn", "installing the proxy policy on " + hit.url + " failed: " + describe(error));
        installed = undefined;
      }
      if (installed !== undefined) {
        if (state !== undefined) state.dispose = installed.dispose;
        log("info", "web_fetch now tunnels through " + installed.url + " (source: " + installed.source + "); the local DNS check is bypassed.");
        return { installed: true, url: installed.url, source: installed.source, dispose: installed.dispose };
      }
      log("warn", "the proxy policy on " + hit.url + " did not take effect; the host keeps its previous route.");
    } else {
      log("warn", "no reachable local proxy found (checked environment, Clash/Mihomo config, Windows system proxy, well-known ports).");
    }

    attempt += 1;
    if (config.retryMs <= 0 || attempt > config.maxRetries) return { installed: false };
    await sleep(config.retryMs);
  }
}

/**
 * Cordis entry point. Returns synchronously and never throws: the asynchronous
 * work runs detached and reports through the logger.
 */
export function apply(ctx, config) {
  const log = makeLogger(ctx);
  const state = { stopped: false, dispose: undefined };

  if (ctx !== null && typeof ctx === "object" && typeof ctx.effect === "function") {
    try {
      ctx.effect(() => () => {
        state.stopped = true;
        const dispose = state.dispose;
        state.dispose = undefined;
        if (typeof dispose === "function") {
          try {
            void Promise.resolve(dispose()).catch(() => {});
          } catch {
            /* the disposer is best effort */
          }
        }
      }, name + ": proxy route");
    } catch (error) {
      log("warn", "registering the lifecycle cleanup failed: " + describe(error));
    }
  }

  void run(ctx, config, state, log).catch((error) => log("warn", "startup failed: " + describe(error)));
  return state;
}

/**
 * Awaited variant used by the tests and by tooling that wants the outcome.
 * @returns the run result plus the installed disposer, when one exists.
 */
export async function start(ctx, config) {
  const log = makeLogger(ctx);
  const state = { stopped: false, dispose: undefined };
  const result = await run(ctx, config, state, log);
  return {
    installed: result.installed === true,
    url: result.url,
    source: result.source,
    alreadyProxied: result.alreadyProxied === true,
    dispose: state.dispose,
  };
}
