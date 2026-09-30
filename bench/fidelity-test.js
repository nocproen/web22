/*
 * Reconstructs the viewer's canvas exactly like the browser does (scroll-copy +
 * rect blits) and compares it against a ground-truth screenshot of the remote
 * page. Guards the relaxed tile matching against ghosting / drift.
 */
const WebSocket = require("ws");
const sharp = require("sharp");
const BASE = "http://127.0.0.1:3000";
const W = 1280, H = 800;

const post = async (p, b) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();

(async () => {
  let s = await post("/api/rb/session", { width: W, height: H, dpr: 1 });
  while (s.preparing) { await new Promise((r) => setTimeout(r, 500)); s = await post("/api/rb/session", { width: W, height: H, dpr: 1 }); }
  const id = s.id;
  await post("/api/rb/command", { session: id, action: "goto", url: "https://en.wikipedia.org/wiki/Web_browser" });
  await new Promise((r) => setTimeout(r, 4500));

  const ws = new WebSocket(`ws://127.0.0.1:3000/api/rb/ws?session=${id}`);
  await new Promise((res) => ws.on("open", res));

  let canvas = Buffer.alloc(W * H * 3, 255);
  let cw = W, ch = H;
  let queue = Promise.resolve();

  const apply = async (buf) => {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const w = dv.getUint16(5), h = dv.getUint16(7), dy = dv.getInt16(9);
    const flags = dv.getUint8(23), count = dv.getUint16(24);
    if (flags & 1 || w !== cw || h !== ch) { canvas = Buffer.alloc(w * h * 3, 255); cw = w; ch = h; }
    if (dy) { // scroll copy: shift existing pixels by -dy
      const next = Buffer.alloc(cw * ch * 3, 255);
      const rowBytes = cw * 3;
      for (let y = 0; y < ch; y++) { const src = y + dy; if (src >= 0 && src < ch) canvas.copy(next, y * rowBytes, src * rowBytes, src * rowBytes + rowBytes); }
      canvas = next;
    }
    let off = 26;
    for (let i = 0; i < count; i++) {
      const x = dv.getUint16(off), y = dv.getUint16(off + 2), rw = dv.getUint16(off + 4), rh = dv.getUint16(off + 6);
      const len = dv.getUint32(off + 8);
      const jpeg = buf.subarray(off + 12, off + 12 + len);
      off += 12 + len;
      let img = sharp(jpeg).removeAlpha();
      const meta = await img.metadata();
      if (meta.width !== rw || meta.height !== rh) img = img.resize(rw, rh);
      const px = await img.raw().toBuffer();
      for (let row = 0; row < rh; row++) {
        const dst = ((y + row) * cw + x) * 3;
        if (y + row >= ch) break;
        px.copy(canvas, dst, row * rw * 3, row * rw * 3 + Math.min(rw, cw - x) * 3);
      }
    }
    ws.send(JSON.stringify({ t: "ack", seq: dv.getUint32(1) }));
  };

  ws.on("message", (d, isBin) => { if (isBin) queue = queue.then(() => apply(d)).catch((e) => console.error("apply", e.message)); });
  await new Promise((r) => setTimeout(r, 2000));

  let seq = 0;
  const iv = setInterval(() => { seq++; ws.send(JSON.stringify({ t: "input", events: [{ type: "wheel", x: 640, y: 400, dx: 0, dy: 50, seq }] })); }, 16);
  await new Promise((r) => setTimeout(r, 3000));
  clearInterval(iv);
  await new Promise((r) => setTimeout(r, 3000)); // let refinement finish
  await queue;
  ws.close();

  // Ground truth: the server's own last full frame, via the SSE fallback transport.
  const res = await fetch(`${BASE}/api/rb/stream?session=${id}`);
  const reader = res.body.getReader();
  let text = "", truth = null;
  while (!truth) {
    const { value, done } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString();
    const m = text.match(/event: frame\ndata: (.+)\n\n/);
    if (m) truth = JSON.parse(m[1]);
  }
  reader.cancel().catch(() => {});
  if (!truth) { console.log("no ground-truth frame"); process.exit(1); }

  const ref = await sharp(Buffer.from(truth.data, "base64")).removeAlpha().raw().toBuffer();
  if (ref.length !== canvas.length) { console.log("size mismatch", ref.length, canvas.length); process.exit(1); }

  let sum = 0, worst = 0, badPixels = 0;
  for (let i = 0; i < ref.length; i += 3) {
    const d = Math.abs(ref[i] - canvas[i]) + Math.abs(ref[i + 1] - canvas[i + 1]) + Math.abs(ref[i + 2] - canvas[i + 2]);
    sum += d;
    if (d > worst) worst = d;
    if (d > 90) badPixels++;
  }
  const px = ref.length / 3;
  const avg = sum / px;
  console.log("=== reconstruction fidelity after scroll + settle ===");
  console.log("mean abs diff / px :", avg.toFixed(2), "(0-765 scale)");
  console.log("worst pixel diff   :", worst);
  console.log("pixels >90 diff    :", badPixels, `(${((badPixels / px) * 100).toFixed(3)}%)`);
  console.log(avg < 6 && badPixels / px < 0.01 ? "OK: viewer matches the real page (no ghosting/drift)" : "WARN: visible divergence");
  await post("/api/rb/session", { id, reset: true });
  process.exit(0);
})();
