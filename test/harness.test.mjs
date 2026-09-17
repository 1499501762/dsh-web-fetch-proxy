import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { fallbackEnvironment, importHarnessModule, loadHarness, resolutionAnchors } from "../lib/harness.js";

test("resolutionAnchors starts inside the harness tree", () => {
  const anchors = resolutionAnchors({ DSH_HOME: path.join("C:", "h"), APPDATA: path.join("C:", "a"), LOCALAPPDATA: path.join("C:", "l") });
  assert.equal(anchors[0], path.join("C:", "h", "profiles", "resolve-anchor.js"));
  assert.ok(anchors.includes(path.join("C:", "h", "profiles", "web", "resolve-anchor.js")));
  assert.ok(anchors.some((anchor) => anchor.includes("resources")));
});

test("resolutionAnchors survives a missing DSH_HOME", () => {
  const anchors = resolutionAnchors({});
  assert.ok(Array.isArray(anchors));
  assert.ok(anchors.length > 0);
});

test("fallbackEnvironment answers the shape dsh-http-proxy reads", () => {
  const env = fallbackEnvironment([{ source: "process", values: { http_proxy: "http://127.0.0.1:7897" } }]);
  assert.equal(env.get("http_proxy").value, "http://127.0.0.1:7897");
  assert.equal(env.get("no_proxy"), undefined);
  if (process.platform === "win32") {
    assert.equal(env.get("HTTP_PROXY").value, "http://127.0.0.1:7897");
  }
});

test("importHarnessModule reports an unresolvable package instead of throwing", async () => {
  assert.equal(await importHarnessModule("@deepseek-ai/dsh-definitely-not-installed", []), undefined);
});

test("loadHarness either returns the proxy module or a reason, never throws", async () => {
  const result = await loadHarness(process.env);
  assert.equal(typeof result.ok, "boolean");
  if (result.ok === true) {
    assert.equal(typeof result.proxy.installProxyFromEnvironment, "function");
    assert.equal(typeof result.proxy.proxyRouteFor, "function");
    assert.equal(typeof result.createSnapshot, "function");
  } else {
    assert.equal(typeof result.reason, "string");
  }
});
