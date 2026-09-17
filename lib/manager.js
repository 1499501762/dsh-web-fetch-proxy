/**
 * Route lifecycle for dsh-web-fetch-proxy.
 *
 * One owner for three things that must stay consistent: the currently installed
 * proxy policy, the live configuration the settings surface writes, and the
 * status a configuration surface reads back.
 *
 * Every reconfiguration bumps a generation, wakes the pending retry timer, and
 * queues a fresh reconcile behind the previous one. A reconcile that finds its
 * generation stale returns without touching the route, so a slow discovery can
 * never overwrite a newer decision.
 *
 * @module dsh-web-fetch-proxy/manager
 */
import { discoverProxy } from "./detect.js";
import { loadHarness } from "./harness.js";

/** Deployment defaults; the settings surface overrides only proxy and noProxy. */
export const DEFAULT_CONFIG = {
  enabled: true,
  proxy: "auto",
  noProxy: "",
  retryMs: 15000,
  maxRetries: 20,
  probeTimeoutMs: 400,
};

/** proxy values that mean "install nothing". */
const DISABLED_VALUES = ["off", "none", "direct", "disable", "disabled", "false"];

/** Whether a proxy config value asks for no route at all. */
export function isProxyDisabled(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return DISABLED_VALUES.indexOf(text.trim().toLowerCase()) >= 0;
}

/** Normalize a partial config; every field is optional and clamped. */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const proxy = typeof source.proxy === "string" && source.proxy.trim() !== "" ? source.proxy.trim() : "auto";
  return {
    enabled: source.enabled !== false,
    proxy,
    noProxy: typeof source.noProxy === "string" ? source.noProxy.trim() : "",
    retryMs: Number.isFinite(source.retryMs) ? Math.max(0, Math.trunc(source.retryMs)) : DEFAULT_CONFIG.retryMs,
    maxRetries: Number.isFinite(source.maxRetries) ? Math.max(0, Math.trunc(source.maxRetries)) : DEFAULT_CONFIG.maxRetries,
    probeTimeoutMs: Number.isFinite(source.probeTimeoutMs) ? Math.max(50, Math.trunc(source.probeTimeoutMs)) : DEFAULT_CONFIG.probeTimeoutMs,
  };
}

function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The policy target the route check uses; any public origin behaves the same. */
function routeProbeUrl() {
  return new URL("https://example.com/");
}

/**
 * Build the route manager.
 *
 * @param options - logger, plus test seams for the harness loader, the proxy
 *   discovery and the clock.
 * @returns configure / redetect / snapshot / config / dispose.
 */
export function createManager(options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const log = typeof opts.log === "function" ? opts.log : function () {};
  const loadHarnessFn = typeof opts.loadHarness === "function" ? opts.loadHarness : loadHarness;
  const discoverFn = typeof opts.discover === "function" ? opts.discover : discoverProxy;
  const now = typeof opts.now === "function" ? opts.now : function () { return Date.now(); };

  const status = {
    phase: "starting",
    proxy: DEFAULT_CONFIG.proxy,
    noProxy: "",
    url: undefined,
    source: undefined,
    attempts: 0,
    message: undefined,
    updatedAt: 0,
  };

  let config = normalizeConfig(DEFAULT_CONFIG);
  let generation = 0;
  let stopped = false;
  let dispose;
  let harnessCache;
  let queue = Promise.resolve();
  const sleepers = new Set();

  function touch() {
    status.updatedAt = now();
  }

  /** Sleep, unless a reconfiguration or a dispose wakes this waiter early. */
  function sleep(ms) {
    return new Promise((resolve) => {
      const entry = { resolve, timer: 0 };
      entry.timer = setTimeout(() => {
        sleepers.delete(entry);
        resolve();
      }, ms);
      sleepers.add(entry);
    });
  }

  /** Wake every pending sleeper so its reconcile loop re-reads the generation. */
  function wake() {
    for (const entry of [...sleepers]) {
      sleepers.delete(entry);
      clearTimeout(entry.timer);
      entry.resolve();
    }
  }

  async function harnessRef() {
    if (harnessCache === undefined) harnessCache = await loadHarnessFn(process.env);
    return harnessCache;
  }

  async function releaseRoute() {
    const current = dispose;
    dispose = undefined;
    if (typeof current !== "function") return;
    try {
      await current();
    } catch (error) {
      log("warn", "释放上一条代理路由失败：" + describe(error));
    }
  }

  /** Install one policy and confirm the provider would actually take the tunnel. */
  async function installRoute(harness, hit, current) {
    const values = { http_proxy: hit.url, https_proxy: hit.url };
    const bypass = [];
    if (current.noProxy !== "") bypass.push(current.noProxy);
    if (typeof process.env.NO_PROXY === "string" && process.env.NO_PROXY.trim() !== "") bypass.push(process.env.NO_PROXY.trim());
    if (typeof process.env.no_proxy === "string" && process.env.no_proxy.trim() !== "") bypass.push(process.env.no_proxy.trim());
    if (bypass.length > 0) values.no_proxy = bypass.join(",");

    const environment = harness.createSnapshot([{ source: "process", values }]);
    const diagnostics = [];
    const released = await harness.proxy.installProxyFromEnvironment(environment, function (message) {
      diagnostics.push(String(message));
    });
    for (const message of diagnostics) log("warn", "代理策略诊断：" + message);

    const route = harness.proxy.proxyRouteFor(routeProbeUrl());
    if (route === undefined || route.proxied !== true) {
      try {
        await released();
      } catch (error) {
        /* the rollback is best effort */
      }
      return undefined;
    }
    return released;
  }

  /** Bring the installed route in line with the current config. */
  async function reconcile(mine) {
    const current = config;
    status.proxy = current.proxy;
    status.noProxy = current.noProxy;
    status.attempts = 0;
    status.message = undefined;

    await releaseRoute();
    if (stopped || mine !== generation) return;

    if (current.enabled !== true) {
      status.phase = "disabled";
      status.url = undefined;
      status.source = undefined;
      touch();
      log("info", "配置为已关闭，不安装代理路由。");
      return;
    }
    if (isProxyDisabled(current.proxy)) {
      status.phase = "disabled";
      status.url = undefined;
      status.source = undefined;
      touch();
      log("info", "proxy 配置为 " + current.proxy + "，不安装代理路由。");
      return;
    }

    const harness = await harnessRef();
    if (stopped || mine !== generation) return;
    if (harness.ok !== true) {
      status.phase = "unavailable";
      status.message = harness.reason;
      touch();
      log("warn", "无法访问宿主网络模块（" + harness.reason + "），插件不做任何改动。");
      return;
    }

    const existing = harness.proxy.proxyRouteFor(routeProbeUrl());
    if (existing !== undefined && existing.proxied === true) {
      status.phase = "ready";
      status.url = existing.proxy;
      status.source = "host";
      touch();
      log("info", "宿主已有一条代理路由，web_fetch 无需改动。");
      return;
    }

    for (;;) {
      if (stopped || mine !== generation) return;
      status.attempts += 1;

      let hit;
      try {
        hit = await discoverFn({ explicit: current.proxy, probeTimeoutMs: current.probeTimeoutMs });
      } catch (error) {
        log("warn", "代理发现失败：" + describe(error));
        hit = undefined;
      }
      if (stopped || mine !== generation) return;

      if (hit !== undefined) {
        let released;
        try {
          released = await installRoute(harness, hit, current);
        } catch (error) {
          log("warn", "在 " + hit.url + " 上安装代理策略失败：" + describe(error));
          released = undefined;
        }
        if (stopped || mine !== generation) {
          if (typeof released === "function") {
            try {
              await released();
            } catch (error) {
              /* a stale install is unwound best effort */
            }
          }
          return;
        }
        if (released !== undefined) {
          dispose = released;
          status.phase = "ready";
          status.url = hit.url;
          status.source = hit.source;
          status.message = undefined;
          touch();
          log("info", "web_fetch 现在经由 " + hit.url + " 出网（来源：" + hit.source + "）；本地 DNS 校验已被代理路由跳过。");
          return;
        }
        status.message = "代理策略未生效";
        log("warn", "在 " + hit.url + " 上安装的代理策略未生效，宿主保持原路由。");
      } else {
        status.message = "未找到可用的本地代理";
        log("warn", "未发现可用的本地代理（已检查环境变量、Clash/Mihomo 配置、Windows 系统代理与常见端口）。");
      }

      if (current.retryMs <= 0 || status.attempts > current.maxRetries) {
        status.phase = "error";
        touch();
        return;
      }
      status.phase = "searching";
      touch();
      await sleep(current.retryMs);
    }
  }

  function schedule() {
    generation += 1;
    const mine = generation;
    wake();
    queue = queue.then(function () {
      return reconcile(mine);
    }).catch(function (error) {
      log("warn", "应用配置失败：" + describe(error));
      status.phase = "error";
      status.message = describe(error);
      touch();
    });
    return queue;
  }

  return {
    /** Merge a partial config and re-apply it. */
    configure(partial) {
      config = normalizeConfig(Object.assign({}, config, partial !== null && typeof partial === "object" ? partial : {}));
      return schedule();
    },
    /** Re-run discovery and installation with the current config. */
    redetect() {
      return schedule();
    },
    /** A snapshot for the configuration surface. */
    snapshot() {
      return {
        phase: status.phase,
        enabled: config.enabled,
        proxy: status.proxy,
        noProxy: status.noProxy,
        url: status.url,
        source: status.source,
        attempts: status.attempts,
        message: status.message,
        retryMs: config.retryMs,
        maxRetries: config.maxRetries,
        updatedAt: status.updatedAt,
      };
    },
    /** The configuration currently in force. */
    config() {
      return Object.assign({}, config);
    },
    /** Stop retrying, drop the route, and settle. */
    dispose() {
      stopped = true;
      generation += 1;
      wake();
      return queue.then(function () {
        return releaseRoute();
      });
    },
  };
}
