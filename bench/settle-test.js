/* Scrolls, stops, and checks the screen is fully refined (crisp) afterwards. */
const WebSocket = require("ws");
const BASE = "http://127.0.0.1:3000";

const post = async (p, b) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();

(async () => {
  let s = await post("/api/rb/session", { width: 1280, height: 800, dpr: 1 });
  while (s.preparing) { await new Promise((r) => setTimeout(r, 500)); s = await post("/api/rb/session", { width: 1280, height: 800, dpr: 1 }); }
  const id = s.id;
  await post("/api/rb/command", { session: id, action: "goto", url: "https://en.wikipedia.org/wiki/Web_browser" });
  await new Promise((r) => setTimeout(r, 4000));

  const ws = new WebSocket(`ws://127.0.0.1:3000/api/rb/ws?session=${id}`);
  await new Promise((res) => ws.on("open", res));
  let motion = 0, refine = 0, refineBytes = 0, phase = "warm";
  ws.on("message", (d, isBin) => {
    if (!isBin) return;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const flags = dv.getUint8(23);
    ws.send(JSON.stringify({ t: "ack", seq: dv.getUint32(1) }));
    if (phase !== "after") return;
    if (flags & 2) { refine++; refineBytes += d.length; } else motion++;
  });
  await new Promise((r) => setTimeout(r, 1500));

  // 2s of scrolling
  let seq = 0;
  const iv = setInterval(() => { seq++; ws.send(JSON.stringify({ t: "input", events: [{ type: "wheel", x: 640, y: 400, dx: 0, dy: 50, seq }] })); }, 16);
  await new Promise((r) => setTimeout(r, 2000));
  phase = "after";
  clearInterval(iv);

  // Watch what the server sends once the wheel stops.
  await new Promise((r) => setTimeout(r, 2500));
  console.log("=== after scroll stops (2.5s window) ===");
  console.log("motion packets :", motion);
  console.log("refine packets :", refine, `(${(refineBytes / 1024).toFixed(0)} KB crisp repaint)`);
  console.log(refine > 0 ? "OK: screen is repainted crisp after settling" : "WARN: no refinement -> stale/soft pixels would linger");
  ws.close();
  await post("/api/rb/session", { id, reset: true });
  process.exit(0);
})();
