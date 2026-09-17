/**
 * End-to-end proof: with a proxy listening on loopback, starting the plugin makes
 * @deepseek-ai/dsh-http-proxy report a proxied route - which is exactly the branch
 * dsh-web-fetch-http takes to skip its local DNS check.
 *
 * The test skips itself when the harness private packages are not resolvable,
 * e.g. in a bare checkout that has no harness installation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { loadHarness } from "../lib/harness.js";
import { start } from "../lib/index.js";

const harness = await loadHarness(process.env);
const skip = harness.ok === true ? false : "harness network modules are not resolvable from here";

test("start() installs a proxied route that web_fetch consults", { skip }, async (t) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await start(undefined, { proxy: "http://127.0.0.1:" + port, retryMs: 0 });
  assert.equal(result.installed, true);
  assert.equal(result.url, "http://127.0.0.1:" + port);

  const route = harness.proxy.proxyRouteFor(new URL("https://raw.githubusercontent.com/x"));
  assert.equal(route.proxied, true);

  await result.dispose();

  const afterDispose = harness.proxy.proxyRouteFor(new URL("https://raw.githubusercontent.com/x"));
  assert.equal(afterDispose.proxied, false);
});

test("start() refuses a proxy that is not listening and reports failure", { skip }, async () => {
  const result = await start(undefined, { proxy: "http://127.0.0.1:1", retryMs: 0, probeTimeoutMs: 120 });
  assert.equal(result.installed, false);
});
