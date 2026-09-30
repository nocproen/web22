/*
 * Integration regression for same-origin WebSocket protection.
 * Run after deploy: node bench/ws-origin-test.js https://your-preview-url
 */
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const base = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
const wsBase = base.replace(/^http/, "ws");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getSession() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${base}/api/rb/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ width: 800, height: 600, dpr: 1, mobile: false }),
    });
    const data = await response.json();
    if (response.ok && data.id) return data.id;
    if (response.status !== 202) throw new Error(`Unable to create test session: ${JSON.stringify(data)}`);
    await wait(500);
  }
  throw new Error("Timed out waiting for the browser engine");
}

function connect(session, origin) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${wsBase}/api/rb/ws?session=${encodeURIComponent(session)}`, { headers: { Origin: origin } });
    const timer = setTimeout(() => {
      socket.terminate();
      resolve({ open: false, error: "timeout" });
    }, 4000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      resolve({ open: true, error: "" });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve({ open: false, error: error.message });
    });
  });
}

(async () => {
  const session = await getSession();
  try {
    const siteOrigin = new URL(base).origin;
    const sameSite = await connect(session, siteOrigin);
    assert.equal(sameSite.open, true, `same-origin viewer should connect: ${sameSite.error}`);

    const crossSite = await connect(session, "https://attacker.example");
    assert.equal(crossSite.open, false, "a different website must not open the viewer socket");
    assert.match(crossSite.error, /403|Unexpected server response/i);
    console.log("PASS: same-origin viewer connects; cross-origin viewer is rejected before receiving screen data.");
  } finally {
    await fetch(`${base}/api/rb/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: session, reset: true }),
    }).catch(() => {});
  }
})().catch((error) => {
  console.error("FAIL: WebSocket origin security regression", error);
  process.exitCode = 1;
});
