/*
 * Security regression: one shared Chromium process, separate user profiles.
 * Run with: node bench/context-isolation.js
 */
const assert = require("node:assert/strict");
const http = require("node:http");
const { chromium } = require("playwright");

(async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end("<!doctype html><html><head><meta charset=utf-8></head><body>context isolation probe</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;
  let browser;
  let alice;
  let bob;

  try {
    browser = await chromium.launch({ channel: "chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    // Matches the production invariant: same Browser process, one fresh context per user.
    alice = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    bob = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    assert.equal(alice.browser(), browser);
    assert.equal(bob.browser(), browser);
    assert.equal(browser.contexts().length, 2);

    await alice.addCookies([{ name: "account", value: "alice-login", domain: "127.0.0.1", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }]);
    await bob.addCookies([{ name: "account", value: "bob-login", domain: "127.0.0.1", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }]);

    const alicePage = await alice.newPage();
    const bobPage = await bob.newPage();
    await Promise.all([alicePage.goto(url), bobPage.goto(url)]);
    await alicePage.evaluate(() => localStorage.setItem("login", "alice-storage"));
    await bobPage.evaluate(() => localStorage.setItem("login", "bob-storage"));

    const aliceTab = await alice.newPage();
    await aliceTab.goto(url);
    const [aliceState, bobState, aliceSecondTabState] = await Promise.all([
      alicePage.evaluate(() => ({ cookie: document.cookie, storage: localStorage.getItem("login") })),
      bobPage.evaluate(() => ({ cookie: document.cookie, storage: localStorage.getItem("login") })),
      aliceTab.evaluate(() => ({ cookie: document.cookie, storage: localStorage.getItem("login") })),
    ]);

    assert.deepEqual(aliceState, { cookie: "account=alice-login", storage: "alice-storage" });
    assert.deepEqual(bobState, { cookie: "account=bob-login", storage: "bob-storage" });
    assert.deepEqual(aliceSecondTabState, aliceState);
    console.log("PASS: one Chromium process; Alice and Bob have isolated cookies/localStorage; Alice's own tabs share her login.");
  } finally {
    await Promise.all([alice?.close(), bob?.close()].filter(Boolean));
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error("FAIL: browser context isolation regression", error);
  process.exitCode = 1;
});
