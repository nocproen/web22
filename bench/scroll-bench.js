/* Measures the real scroll pipeline: wheel in -> screen packets out. */
const WebSocket = require("ws");

const BASE = "http://127.0.0.1:3000";
const URL_TO_LOAD = process.argv[2] || "https://en.wikipedia.org/wiki/Web_browser";
const DURATION = Number(process.argv[3] || 5000);

const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
};

function parseHeader(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    seq: dv.getUint32(1),
    w: dv.getUint16(5),
    h: dv.getUint16(7),
    dy: dv.getInt16(9),
    scrollY: dv.getInt32(11),
    inputSeq: dv.getUint32(19),
    flags: dv.getUint8(23),
    rects: dv.getUint16(24),
    bytes: buf.length,
  };
}

(async () => {
  let s = await post("/api/rb/session", { width: 1280, height: 800, dpr: 1 });
  while (s.preparing) {
    await new Promise((r) => setTimeout(r, 500));
    s = await post("/api/rb/session", { width: 1280, height: 800, dpr: 1 });
  }
  const id = s.id;
  await post("/api/rb/command", { session: id, action: "goto", url: URL_TO_LOAD });
  await new Promise((r) => setTimeout(r, 4000));

  const ws = new WebSocket(`ws://127.0.0.1:3000/api/rb/ws?session=${id}`);
  await new Promise((res) => ws.on("open", res));

  const packets = [];
  let scrollMsgs = 0;
  let lastAt = 0;
  ws.on("message", (d, isBin) => {
    const now = Date.now();
    if (isBin) {
      const h = parseHeader(d);
      h.gap = lastAt ? now - lastAt : 0;
      lastAt = now;
      packets.push(h);
      ws.send(JSON.stringify({ t: "ack", seq: h.seq })); // simulate instant client draw
    } else {
      const m = JSON.parse(d.toString());
      if (m.t === "scroll") scrollMsgs++;
    }
  });
  ws.on("ping", () => {});

  await new Promise((r) => setTimeout(r, 1200));
  packets.length = 0;
  lastAt = 0;
  scrollMsgs = 0;

  // Simulate a user flicking the wheel: a burst every 16ms, like a trackpad.
  let seq = 0;
  const t0 = Date.now();
  const timer = setInterval(() => {
    seq += 1;
    ws.send(JSON.stringify({ t: "input", events: [{ type: "wheel", x: 640, y: 400, dx: 0, dy: 50, seq }] }));
  }, 16);

  await new Promise((r) => setTimeout(r, DURATION));
  clearInterval(timer);
  const elapsed = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 600));
  ws.close();

  const motion = packets.filter((p) => !(p.flags & 2));
  const refine = packets.filter((p) => p.flags & 2);
  const gaps = motion.map((p) => p.gap).filter((g) => g > 0).sort((a, b) => a - b);
  const pct = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);

  console.log("=== scroll bench ===");
  console.log("wheels sent        :", seq, `(${(seq / (elapsed / 1000)).toFixed(1)}/s)`);
  console.log("motion packets     :", motion.length, `-> ${(motion.length / (elapsed / 1000)).toFixed(1)} fps`);
  console.log("refine packets     :", refine.length);
  console.log("scroll msgs        :", scrollMsgs);
  console.log("gap ms p50/p90/max :", pct(gaps, 0.5), pct(gaps, 0.9), gaps[gaps.length - 1] ?? 0);
  console.log("bytes total        :", (sum(packets.map((p) => p.bytes)) / 1024).toFixed(0), "KB");
  console.log("avg motion pkt     :", motion.length ? (sum(motion.map((p) => p.bytes)) / motion.length / 1024).toFixed(1) : 0, "KB");
  console.log("dy used (scrollcpy):", motion.filter((p) => p.dy !== 0).length, "/", motion.length);
  console.log("scrollY null       :", motion.filter((p) => p.scrollY < 0).length, "/", motion.length);
  console.log("avg rects/pkt      :", motion.length ? (sum(motion.map((p) => p.rects)) / motion.length).toFixed(1) : 0);
  await post("/api/rb/session", { id, reset: true });
  process.exit(0);
})();
