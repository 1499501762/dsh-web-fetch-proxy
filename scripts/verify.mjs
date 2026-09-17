/**
 * Live verification for dsh-web-fetch-proxy.
 *
 * Runs the real web_fetch provider in-process, once before and once after the
 * plugin installs its route, and prints both outcomes. Use it to confirm the fix
 * on a machine whose TUN proxy returns fake-ip answers.
 *
 *   node scripts/verify.mjs [url]
 *
 * Nothing here talks to the running harness: it is a separate process that
 * installs and then disposes its own proxy policy.
 */
import { importHarnessModule, loadHarness, resolutionAnchors } from "../lib/harness.js";
import { start } from "../lib/index.js";

const target = process.argv[2] || "https://raw.githubusercontent.com/kriskite/dsh-network-proxy/main/package.json";
const anchors = resolutionAnchors(process.env);

const harness = await loadHarness(process.env);
if (harness.ok !== true) {
  console.log("cannot reach the harness network modules: " + harness.reason);
  process.exitCode = 1;
} else {
  const web = await importHarnessModule("@deepseek-ai/dsh-web-fetch-http", anchors);
  if (web === undefined || typeof web.HttpFetchProvider !== "function") {
    console.log("cannot load @deepseek-ai/dsh-web-fetch-http");
    process.exitCode = 1;
  } else {
    const provider = new web.HttpFetchProvider({
      maxResponseBytes: 5000000,
      maxBodyChars: 100000,
      timeoutMs: 30000,
      maxRedirects: 5,
      userAgent: "dsh-web-fetch-proxy-verify/1.0",
    });

    const summary = () => {
      const route = harness.proxy.proxyRouteFor(new URL(target));
      return route !== undefined && route.proxied === true ? "proxied via " + route.proxy : "direct (local DNS check applies)";
    };

    console.log("target        : " + target);
    console.log("route before  : " + summary());
    try {
      const response = await provider.fetch({ url: target });
      console.log("fetch before  : ok, " + response.statusCode + ", " + response.body.content.length + " chars");
    } catch (error) {
      console.log("fetch before  : " + (error && error.code ? error.code + " " : "") + (error && error.message ? error.message : String(error)));
    }

    const result = await start(undefined, { retryMs: 0 });
    console.log("installed     : " + String(result.installed) + (result.url ? " on " + result.url : ""));
    console.log("route after   : " + summary());

    try {
      const response = await provider.fetch({ url: target });
      console.log("fetch after   : ok, " + response.statusCode + ", " + response.body.content.length + " chars");
      console.log("body head     : " + JSON.stringify(response.body.content.slice(0, 160)));
    } catch (error) {
      console.log("fetch after   : " + (error && error.code ? error.code + " " : "") + (error && error.message ? error.message : String(error)));
      process.exitCode = 1;
    }

    if (typeof result.dispose === "function") await result.dispose();
    console.log("route disposed: " + summary());
  }
}
