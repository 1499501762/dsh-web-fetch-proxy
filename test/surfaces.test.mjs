import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { SETTINGS_NAMESPACE, STATUS_PATH, apply, validateSettings } from "../lib/index.js";

/** A cordis stand-in capturing the settings namespace, the webserver route, and the effects. */
function createHarness() {
  const registrations = [];
  const routes = [];
  const disposers = [];
  const watchers = new Set();
  let current = { proxy: "auto", noProxy: "" };

  const logger = { info() {}, warn() {}, error() {}, debug() {} };

  const settingsCtx = {
    logger,
    settings: {
      register(ns, schema, options) {
        registrations.push({ ns, schema, options });
        current = schema(Object.assign({}, options && options.base));
        return {
          get: () => current,
          watch(fn) { watchers.add(fn); return () => watchers.delete(fn); },
        };
      },
    },
    effect(factory) { disposers.push(factory()); return () => {}; },
  };

  const serverCtx = {
    logger,
    effect(factory) { disposers.push(factory()); return () => {}; },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    webRuntime: { trustedHosts: [] },
  };

  const ctx = {
    logger,
    effect(factory) { disposers.push(factory()); return () => {}; },
    inject(names, callback) {
      if (names.indexOf("settings") >= 0) callback(settingsCtx);
      if (names.indexOf("webServer") >= 0) callback(serverCtx);
    },
  };

  return {
    ctx, registrations, routes, disposers,
    value: () => current,
    set(next) { current = Object.assign({}, current, next); for (const fn of watchers) fn(current); },
    async close() { for (const dispose of disposers) { try { await dispose(); } catch (error) { /* ignore */ } } },
  };
}

/** Drive one registered route handler with a synthetic request. */
function invoke(handler, body, options) {
  const headers = Object.assign({ host: "127.0.0.1:43129", "content-type": "application/json" }, options && options.headers);
  const req = new Readable({ read() {} });
  req.method = (options && options.method) || "POST";
  req.headers = headers;
  const captured = { statusCode: 0, body: undefined };
  const res = {
    writeHead(statusCode) { captured.statusCode = statusCode; },
    end(text) { captured.body = text === undefined || text === "" ? undefined : JSON.parse(text); },
  };
  const settled = handler(req, res);
  req.push(JSON.stringify(body || {}));
  req.push(null);
  return settled.then(() => captured);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test("apply registers the settings namespace and the status route", async () => {
  const harness = createHarness();
  apply(harness.ctx, { proxy: "auto", noProxy: ".internal" });
  await settle();

  assert.equal(harness.registrations.length, 1);
  const registration = harness.registrations[0];
  assert.equal(registration.ns, SETTINGS_NAMESPACE);
  assert.equal(registration.options.applies, "live");
  assert.deepEqual(registration.options.base, { proxy: "auto", noProxy: ".internal" });
  assert.equal(harness.value().proxy, "auto");
  assert.equal(harness.value().noProxy, ".internal");
  assert.equal(typeof registration.options.validate, "function");

  assert.equal(harness.routes.length, 1);
  assert.equal(harness.routes[0].kind, "exact");
  assert.equal(harness.routes[0].path, STATUS_PATH);
  await harness.close();
});

test("the status route reports the live snapshot", async () => {
  const harness = createHarness();
  apply(harness.ctx, { proxy: "off" });
  await settle();

  const response = await invoke(harness.routes[0].handler, { action: "status" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.value.proxy, "off");
  assert.equal(response.body.value.phase, "disabled");
  await harness.close();
});

test("a settings change re-applies the route live", async () => {
  const harness = createHarness();
  apply(harness.ctx, { proxy: "auto" });
  await settle();

  harness.set({ proxy: "off" });
  await settle();

  const response = await invoke(harness.routes[0].handler, { action: "status" });
  assert.equal(response.body.value.proxy, "off");
  assert.equal(response.body.value.phase, "disabled");
  await harness.close();
});

test("the status route is fenced and method-checked", async () => {
  const harness = createHarness();
  apply(harness.ctx, { proxy: "off" });
  await settle();
  const handler = harness.routes[0].handler;

  const crossSite = await invoke(handler, { action: "status" }, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.statusCode, 403);
  assert.equal(crossSite.body.ok, false);

  const foreignHost = await invoke(handler, { action: "status" }, { headers: { host: "evil.example" } });
  assert.equal(foreignHost.statusCode, 403);

  const get = await invoke(handler, undefined, { method: "GET" });
  assert.equal(get.statusCode, 405);

  await harness.close();
});

test("validateSettings accepts auto, off, URLs and host:port, and rejects the rest", () => {
  assert.doesNotThrow(() => validateSettings({ proxy: "auto" }));
  assert.doesNotThrow(() => validateSettings({ proxy: "off" }));
  assert.doesNotThrow(() => validateSettings({ proxy: "http://127.0.0.1:7897" }));
  assert.doesNotThrow(() => validateSettings({ proxy: "127.0.0.1:7897" }));
  assert.doesNotThrow(() => validateSettings({}));
  assert.throws(() => validateSettings({ proxy: "socks5://127.0.0.1:1080" }), /代理地址/);
});
