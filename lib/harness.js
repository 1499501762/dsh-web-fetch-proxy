/**
 * Host-side access to the harness's own network modules.
 *
 * dsh-web-fetch-http decides between "tunnel through the proxy" and "resolve the
 * hostname locally and check it is public" by asking
 * @deepseek-ai/dsh-http-proxy for its process-wide policy. Installing a policy
 * therefore only works when this plugin reaches the *same module instance* the
 * running web-fetch provider uses.
 *
 * A plugin installed with "link:" from outside the harness tree cannot resolve
 * the harness's private packages by bare specifier, so every candidate anchor
 * inside the harness tree is tried first. Node de-duplicates ES modules by real
 * path, so any anchor that resolves through the harness's own node_modules
 * yields the identical instance (see the identity check in the README).
 *
 * @module dsh-web-fetch-proxy/harness
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The package that owns the process-wide outbound proxy policy. */
export const PROXY_PACKAGE = "@deepseek-ai/dsh-http-proxy";

/** The package that models the launch environment the policy is resolved from. */
export const LAUNCH_PACKAGE = "@deepseek-ai/dsh-launch-environment";

/**
 * Anchor files whose node_modules ancestry reaches the harness's own packages.
 * The files never have to exist; only their directory is used for resolution.
 */
export function resolutionAnchors(env) {
  const source = env === null || typeof env !== "object" ? process.env : env;
  const anchors = [];
  const home = source.DSH_HOME;
  if (typeof home === "string" && home.trim() !== "") {
    anchors.push(path.join(home, "profiles", "resolve-anchor.js"));
    anchors.push(path.join(home, "profiles", "web", "resolve-anchor.js"));
  }
  const appData = source.APPDATA;
  if (typeof appData === "string" && appData.trim() !== "") {
    anchors.push(path.join(appData, "dsh-desktop", "harness", "profiles", "web", "resolve-anchor.js"));
  }
  if (typeof process.execPath === "string" && process.execPath !== "") {
    anchors.push(path.join(path.dirname(process.execPath), "resources", "app", "resolve-anchor.js"));
  }
  const localAppData = source.LOCALAPPDATA;
  if (typeof localAppData === "string" && localAppData.trim() !== "") {
    anchors.push(path.join(localAppData, "Programs", "DSH Desktop", "resources", "app", "resolve-anchor.js"));
  }
  try {
    anchors.push(path.join(process.cwd(), "resolve-anchor.js"));
  } catch {
    /* an unavailable cwd is not fatal: the anchored attempts above still run */
  }
  return anchors;
}

/**
 * Import a harness package, preferring resolution anchored inside the harness tree.
 * @returns the module namespace, or undefined when nothing resolved or evaluated.
 */
export async function importHarnessModule(specifier, anchors) {
  for (const anchor of anchors) {
    let resolved;
    try {
      resolved = createRequire(anchor).resolve(specifier);
    } catch {
      continue;
    }
    try {
      return await import(pathToFileURL(resolved).href);
    } catch {
      /* an unloadable candidate must not stop the remaining anchors */
    }
  }
  try {
    return await import(specifier);
  } catch {
    return undefined;
  }
}

/**
 * Require a harness package synchronously through the same anchors.
 *
 * Only for packages that publish a CommonJS build through their exports map
 * (@deepseek-ai/schemastery does: `require` -> lib/index.cjs). Settings
 * registration happens inside a synchronous cordis inject callback, so the
 * schema module has to resolve without awaiting.
 *
 * @param specifier - the package name to require.
 * @param anchors - resolution anchors, as built by {@link resolutionAnchors}.
 * @returns the required exports, or undefined when no anchor resolved it.
 */
export function requireHarnessModule(specifier, anchors) {
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)(specifier);
    } catch {
      /* try the next anchor */
    }
  }
  try {
    return createRequire(import.meta.url)(specifier);
  } catch {
    return undefined;
  }
}

/**
 * Minimal launch-environment stand-in, used only when the real helper is absent.
 * It implements the single method dsh-http-proxy reads: get(name) -> { value }.
 */
export function fallbackEnvironment(layers) {
  const values = new Map();
  const list = Array.isArray(layers) ? layers : [];
  for (const layer of list) {
    const entries = layer !== null && typeof layer === "object" && layer.values !== null && typeof layer.values === "object"
      ? Object.entries(layer.values)
      : [];
    for (const [key, value] of entries) {
      const envName = process.platform === "win32" ? key.toUpperCase() : key;
      if (!values.has(envName)) values.set(envName, value);
    }
  }
  return {
    get(name) {
      const envName = process.platform === "win32" ? String(name).toUpperCase() : String(name);
      return values.has(envName) ? { value: String(values.get(envName)), source: "process" } : undefined;
    },
  };
}

/**
 * Load everything the plugin needs from the host.
 * @returns { ok: true, proxy, createSnapshot } or { ok: false, reason }.
 */
export async function loadHarness(env) {
  const anchors = resolutionAnchors(env);
  const proxy = await importHarnessModule(PROXY_PACKAGE, anchors);
  if (proxy === undefined) return { ok: false, reason: "cannot import " + PROXY_PACKAGE };
  if (typeof proxy.installProxyFromEnvironment !== "function") {
    return { ok: false, reason: PROXY_PACKAGE + " does not export installProxyFromEnvironment" };
  }
  if (typeof proxy.proxyRouteFor !== "function") {
    return { ok: false, reason: PROXY_PACKAGE + " does not export proxyRouteFor" };
  }
  const launch = await importHarnessModule(LAUNCH_PACKAGE, anchors);
  const createSnapshot = launch !== undefined && typeof launch.createLaunchEnvironmentSnapshot === "function"
    ? launch.createLaunchEnvironmentSnapshot
    : fallbackEnvironment;
  return { ok: true, proxy, createSnapshot };
}
