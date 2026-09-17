/**
 * Proxy discovery for dsh-web-fetch-proxy.
 *
 * Everything here uses node: builtins only, so the plugin can never fail to
 * evaluate because a harness package is missing.
 *
 * Resolution order used by discoverProxy():
 *   1. the plugin's own "proxy" config value (an explicit http(s) URL)
 *   2. DSH_WEB_FETCH_PROXY, then HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 *   3. the mixed-port of a local Clash / Mihomo / Clash Verge runtime config
 *   4. the Windows WinINET system proxy (HKCU Internet Settings)
 *   5. a TCP probe of well-known local proxy ports
 *
 * Every candidate must accept a TCP connection before it is returned, so a
 * stale config entry never installs a route to a proxy that is not running.
 *
 * @module dsh-web-fetch-proxy/detect
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** Local ports commonly used by Clash, Mihomo, Clash Verge, v2rayN and Surge. */
export const WELL_KNOWN_PORTS = [7897, 7890, 7891, 7899, 10809, 10808, 1080, 2080, 20171, 8889];

/** Proxy environment variables consulted in order; the plugin's own name wins. */
export const PROXY_ENV_NAMES = [
  "DSH_WEB_FETCH_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "all_proxy",
  "ALL_PROXY",
];

/** Keys Clash-family configs use for the mixed HTTP(S) listener. */
const MIXED_PORT_KEYS = ["mixed-port", "mixed_port", "verge_mixed_port", "verge-mixed-port"];

/** Registry path holding the interactive user's WinINET proxy configuration. */
const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/**
 * Normalize a user-supplied proxy endpoint.
 * Accepts "http://host:port", "https://host:port" and the bare "host:port" shorthand.
 * SOCKS and every other scheme is rejected, matching what @deepseek-ai/dsh-http-proxy can route.
 */
export function normalizeProxyUrl(value) {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw === "") return undefined;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : "http://" + raw;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.hostname === "") return undefined;
  return withScheme;
}

/** Strip one pair of surrounding single or double quotes. */
export function stripQuotes(value) {
  let out = String(value).trim();
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) out = out.slice(1, -1);
  }
  return out;
}

/**
 * Read the mixed-port out of a Clash-family YAML document without a YAML parser.
 *
 * Line-oriented on purpose: the plugin must stay dependency-free, and the key is
 * always a top-level scalar in every config family this plugin knows about.
 */
export function parseMixedPort(text) {
  if (typeof text !== "string") return undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = stripQuotes(trimmed.slice(0, colon));
    if (MIXED_PORT_KEYS.indexOf(key) < 0) continue;
    const rest = trimmed.slice(colon + 1).split("#")[0].trim();
    const port = Number(stripQuotes(rest));
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  return undefined;
}

/**
 * Find the mixed-port of a running Clash-family client.
 * @param options - test seams: home/appData/localAppData overrides and an explicit file list.
 * @returns the port and the file it came from, or undefined.
 */
export function readClashMixedPort(options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const home = opts.home || os.homedir();
  const appData = opts.appData || process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = opts.localAppData || process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const files = Array.isArray(opts.files) && opts.files.length > 0 ? opts.files : [
    path.join(appData, "io.github.clash-verge-rev.clash-verge-rev", "config.yaml"),
    path.join(appData, "io.github.clash-verge-rev.clash-verge-rev", "clash-verge.yaml"),
    path.join(localAppData, "io.github.clash-verge-rev.clash-verge-rev", "config.yaml"),
    path.join(appData, "clash-verge", "config.yaml"),
    path.join(appData, "clash-verge-rev", "config.yaml"),
    path.join(appData, "clash", "config.yaml"),
    path.join(home, ".config", "clash", "config.yaml"),
    path.join(home, ".config", "mihomo", "config.yaml"),
  ];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const port = parseMixedPort(text);
    if (port !== undefined) return { port, file };
  }
  return undefined;
}

/**
 * Parse a WinINET ProxyServer value.
 * Handles the bare "host:port" form and the "http=...;https=..." protocol form.
 */
export function parseWindowsProxyServer(value) {
  const entries = String(value === undefined || value === null ? "" : value)
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) return undefined;
  const named = {};
  let fallback;
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 0) {
      if (fallback === undefined) fallback = entry;
      continue;
    }
    named[entry.slice(0, separator).trim().toLowerCase()] = entry.slice(separator + 1).trim();
  }
  for (const candidate of [named.https, named.http, fallback]) {
    const url = normalizeProxyUrl(candidate);
    if (url !== undefined) return { url, source: "windows-registry" };
  }
  return undefined;
}

/** Read one WinINET registry value; undefined on any other platform or on failure. */
function registryValue(name) {
  if (process.platform !== "win32") return undefined;
  try {
    const output = execFileSync("reg", ["query", INTERNET_SETTINGS_KEY, "/v", name], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    for (const line of String(output).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(name)) continue;
      if (trimmed.indexOf("REG_SZ") < 0 && trimmed.indexOf("REG_DWORD") < 0) continue;
      const parts = trimmed.split(/\s+/);
      return parts[parts.length - 1].trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The Windows system proxy, when ProxyEnable is on and a server is configured. */
export function readWindowsSystemProxy() {
  if (process.platform !== "win32") return undefined;
  const enabled = registryValue("ProxyEnable");
  if (enabled !== "0x1" && enabled !== "1") return undefined;
  const server = registryValue("ProxyServer");
  if (server === undefined || server === "") return undefined;
  return parseWindowsProxyServer(server);
}

/** Resolve when a TCP connection to host:port is established, false on timeout or error. */
export function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 400);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Whether a proxy URL's host:port accepts a TCP connection right now. */
export async function isReachable(url, timeoutMs) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  return await probeTcp(parsed.hostname, port, timeoutMs);
}

/** The first usable proxy URL among PROXY_ENV_NAMES. */
export function readEnvProxy(env) {
  const source = env === null || typeof env !== "object" ? {} : env;
  for (const envName of PROXY_ENV_NAMES) {
    const url = normalizeProxyUrl(source[envName]);
    if (url !== undefined) return { url, source: "env:" + envName };
  }
  return undefined;
}

/**
 * Find a local proxy that is actually accepting connections.
 *
 * @param options - explicit config value, environment snapshot, probe timeout,
 *   reachability seam, clash file overrides and the port probe list.
 * @returns { url, source } for the first reachable candidate, or undefined.
 */
export async function discoverProxy(options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const timeoutMs = Number.isFinite(opts.probeTimeoutMs) ? opts.probeTimeoutMs : 400;
  const reachable = typeof opts.reachable === "function" ? opts.reachable : isReachable;
  const explicit = typeof opts.explicit === "string" ? opts.explicit.trim() : "auto";

  if (explicit !== "" && explicit.toLowerCase() !== "auto") {
    const url = normalizeProxyUrl(explicit);
    if (url === undefined) return undefined;
    return (await reachable(url, timeoutMs)) ? { url, source: "config" } : undefined;
  }

  const fromEnv = readEnvProxy(opts.env === undefined ? process.env : opts.env);
  if (fromEnv !== undefined && (await reachable(fromEnv.url, timeoutMs))) return fromEnv;

  const clash = readClashMixedPort(opts.clashOptions);
  if (clash !== undefined) {
    const url = "http://127.0.0.1:" + clash.port;
    if (await reachable(url, timeoutMs)) return { url, source: "clash-config:" + clash.file };
  }

  const system = readWindowsSystemProxy();
  if (system !== undefined && (await reachable(system.url, timeoutMs))) return system;

  const ports = Array.isArray(opts.ports) && opts.ports.length > 0 ? opts.ports : WELL_KNOWN_PORTS;
  for (const port of ports) {
    const url = "http://127.0.0.1:" + port;
    if (await reachable(url, timeoutMs)) return { url, source: "port-probe:" + port };
  }

  return undefined;
}
