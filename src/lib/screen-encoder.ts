import sharp from "sharp";
import type { Frame, Quality } from "./remote-browser";

/**
 * Per-connection screen encoder (the same idea VNC / RDP use):
 *
 *  1. Tile diff     – the screen is split into 64px tiles; only tiles that differ
 *                     from what the client already shows are sent.
 *  2. Scroll copy   – when the page scrolled, the client shifts its existing
 *                     pixels and we only send the newly exposed strip plus
 *                     anything that really changed (sticky headers etc.).
 *  3. Rate control  – bytes in flight are limited to bandwidth × RTT, so
 *                     nothing queues up; quality adapts to measured bandwidth.
 *  4. Refinement    – regions sent at reduced quality while things were moving
 *                     are re-sent crisp as soon as the screen settles.
 *
 * Packets are deltas and must all be applied in order, so instead of dropping
 * packets we skip *source* frames: the next diff is always computed against
 * exactly what the client has.
 */

const TILE = 64;
const HEADER = 26;
const MAX_RECTS = 48;
const MAX_INFLIGHT = 8;
const REFINE_DELAY = 320;
const MOTION_LADDER = [75, 62, 50, 40];

type Raw = { buf: Buffer; w: number; h: number; tab: number; scrollY: number | null };
type Rect = { x: number; y: number; w: number; h: number };
type Encoded = Rect & { data: Buffer };
type Inflight = { bytes: number; sentAt: number; delivered: number; deliveredAt: number };

export type EncoderStats = { bw: number; rtt: number; q: number; scale: number };

type Prefs = () => { quality: Quality; maxScrollY: number; dpr: number };

const REFINE_Q: Record<Quality, number> = { auto: 82, smooth: 72, balanced: 82, sharp: 90 };
const FIXED_MOTION: Record<Exclude<Quality, "auto">, { q: number; s: number }> = {
  smooth: { q: 45, s: 0.75 },
  balanced: { q: 62, s: 1 },
  sharp: { q: 80, s: 1 },
};

export class ScreenEncoder {
  private latest: Frame | null = null;
  private ref: Raw | null = null;
  private lowq: Uint8Array | null = null;
  private busy = false;
  private closed = false;
  private seq = 0;
  private refineTimer: NodeJS.Timeout | null = null;

  // rate control
  private inflight = new Map<number, Inflight>();
  private inflightBytes = 0;
  private delivered = 0;
  private lastAckAt = 0;
  private bwSamples: { v: number; at: number }[] = [];
  private bw = 600_000; // bytes/s, optimistic start; corrected after a few acks
  private rtt = 80;

  // bytes-per-pixel estimates per JPEG quality (learned from real encodes)
  private bpp = new Map<number, number>([
    [40, 0.04], [50, 0.047], [62, 0.056], [75, 0.07], [76, 0.072], [80, 0.078], [82, 0.09], [84, 0.1], [90, 0.13], [72, 0.066],
  ]);
  private lastQ = 0;
  private lastScale = 1;

  constructor(private send: (packet: Buffer) => void, private prefs: Prefs) {}

  close() {
    this.closed = true;
    if (this.refineTimer) clearTimeout(this.refineTimer);
  }

  stats(): EncoderStats {
    return { bw: Math.round(this.bw / 1024), rtt: Math.round(this.rtt), q: this.lastQ, scale: this.lastScale };
  }

  setRtt(ms: number) {
    this.rtt = this.rtt ? this.rtt * 0.6 + ms * 0.4 : ms;
  }

  push(frame: Frame) {
    this.latest = frame;
    this.pump();
  }

  /** Forces a full repaint (e.g. after the client recreated its canvas). */
  resetReference() {
    this.ref = null;
    this.lowq = null;
  }

  ack(seq: number) {
    const entry = this.inflight.get(seq);
    if (!entry) return;
    this.inflight.delete(seq);
    this.inflightBytes -= entry.bytes;
    const now = Date.now();
    this.delivered += entry.bytes;
    this.lastAckAt = now;
    // Delivery-rate sample (BBR-style): bytes delivered since this packet was sent / elapsed.
    const interval = now - entry.deliveredAt;
    if (interval > 5) {
      const sample = ((this.delivered - entry.delivered) / interval) * 1000;
      this.bwSamples.push({ v: sample, at: now });
      this.bwSamples = this.bwSamples.filter((s) => now - s.at < 4000).slice(-16);
      this.bw = Math.max(40_000, ...this.bwSamples.map((s) => s.v));
    }
    this.pump();
  }

  private canSend() {
    if (this.inflight.size === 0) return true;
    if (this.inflight.size >= MAX_INFLIGHT) return false;
    return this.inflightBytes < (this.bw * (this.rtt + 100)) / 1000;
  }

  private pump() {
    if (this.busy || this.closed || !this.latest || !this.canSend()) return;
    const frame = this.latest;
    this.latest = null;
    this.busy = true;
    this.encodeFrame(frame)
      .catch(() => {})
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }

  /* ------------------------------------------------------------------ */

  private async encodeFrame(frame: Frame) {
    const decoded = await sharp(Buffer.from(frame.data, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (this.closed) return;
    const { width: w, height: h } = decoded.info;
    const raw: Raw = { buf: decoded.data, w, h, tab: frame.tab, scrollY: frame.scrollY };
    const ref = this.ref;
    const reset = !ref || ref.w !== w || ref.h !== h || ref.tab !== frame.tab;
    const cols = Math.ceil(w / TILE);
    const rows = Math.ceil(h / TILE);

    // Root scroll since the client's current picture, in device pixels.
    let dy = 0;
    if (!reset && ref.scrollY !== null && raw.scrollY !== null) {
      const deviceDelta = Math.round((raw.scrollY - ref.scrollY) * this.prefs().dpr);
      if (deviceDelta !== 0 && Math.abs(deviceDelta) < h * 0.85) dy = deviceDelta;
    }

    const dirty = new Uint8Array(cols * rows);
    const nextLowq = new Uint8Array(cols * rows);
    if (reset) {
      dirty.fill(1);
    } else {
      for (let ty = 0; ty < rows; ty += 1) {
        for (let tx = 0; tx < cols; tx += 1) {
          const index = ty * cols + tx;
          if (!this.tileClean(raw, ref, tx, ty, dy)) {
            dirty[index] = 1;
          } else if (this.lowq) {
            // The client keeps (shifted) pixels here; carry over their quality state.
            const y0 = ty * TILE + dy;
            const y1 = Math.min(h, ty * TILE + TILE) - 1 + dy;
            const a = Math.floor(Math.max(0, Math.min(h - 1, y0)) / TILE) * cols + tx;
            const b = Math.floor(Math.max(0, Math.min(h - 1, y1)) / TILE) * cols + tx;
            nextLowq[index] = this.lowq[a] | this.lowq[b];
          }
        }
      }
    }

    const rects = mergeRects(dirty, cols, rows, w, h);
    const flags = reset ? 1 : 0;
    const inputSeq = frame.inputSeq;

    if (rects.length === 0 && dy === 0) {
      // Nothing visible changed; still adopt the new reference (scroll position etc.).
      this.ref = raw;
      this.lowq = nextLowq;
      return;
    }

    const quality = this.prefs().quality;
    const refineQ = REFINE_Q[quality];
    const dirtyPixels = rects.reduce((sum, r) => sum + r.w * r.h, 0);
    const fraction = dirtyPixels / (w * h);

    let q = refineQ;
    let s = 1;
    if (fraction > 0.12) {
      ({ q, s } = this.chooseMotion(quality, dirtyPixels));
    }
    // Only worth a crisp re-send if the motion encode was noticeably worse.
    const reduced = q < refineQ - 6 || s < 1;
    if (reduced) {
      for (const r of rects) markTiles(nextLowq, cols, r, 1);
    } else {
      for (const r of rects) markTiles(nextLowq, cols, r, 0);
    }

    const encoded = await this.encodeRects(raw, rects, q, s);
    if (this.closed) return;
    this.lastQ = q;
    this.lastScale = s;
    this.sendPacket({ w, h, dy, scrollY: raw.scrollY, inputSeq, flags, rects: encoded });
    this.ref = raw;
    this.lowq = nextLowq;
    this.scheduleRefine();
  }

  private chooseMotion(quality: Quality, pixels: number) {
    if (quality !== "auto") return FIXED_MOTION[quality];
    // Aim for ~8+ big updates per second on the measured link.
    const budget = this.bw * 0.12;
    for (const q of MOTION_LADDER) {
      if (pixels * (this.bpp.get(q) ?? 0.06) <= budget) return { q, s: 1 };
    }
    const base = pixels * (this.bpp.get(40) ?? 0.04);
    const s = base * 0.5625 <= budget ? 0.75 : 0.5;
    return { q: 40, s };
  }

  private tileClean(raw: Raw, ref: Raw, tx: number, ty: number, dy: number) {
    const { w, h } = raw;
    const x0 = tx * TILE;
    const x1 = Math.min(w, x0 + TILE);
    const y0 = ty * TILE;
    const y1 = Math.min(h, y0 + TILE);
    if (y0 + dy < 0 || y1 - 1 + dy >= h) return false;
    const rowBytes = (x1 - x0) * 3;
    let exact = true;
    for (let y = y0; y < y1; y += 1) {
      const a = (y * w + x0) * 3;
      const b = ((y + dy) * w + x0) * 3;
      if (raw.buf.compare(ref.buf, b, b + rowBytes, a, a + rowBytes) !== 0) {
        exact = false;
        break;
      }
    }
    if (exact) return true;
    if (dy === 0) return false;
    // After a scroll the JPEG block grid moved, so identical content decodes
    // slightly differently. Accept tiles that match within compression noise.
    let max = 0;
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y += 2) {
      const ra = y * w * 3;
      const rb = (y + dy) * w * 3;
      for (let x = x0; x < x1; x += 2) {
        const ia = ra + x * 3;
        const ib = rb + x * 3;
        const d = Math.abs(raw.buf[ia] - ref.buf[ib]) + Math.abs(raw.buf[ia + 1] - ref.buf[ib + 1]) + Math.abs(raw.buf[ia + 2] - ref.buf[ib + 2]);
        if (d > max) {
          max = d;
          if (max > 120) return false;
        }
        sum += d;
        count += 1;
      }
    }
    return sum / count <= 10;
  }

  private async encodeRects(raw: Raw, rects: Rect[], q: number, s: number): Promise<Encoded[]> {
    const input = { raw: { width: raw.w, height: raw.h, channels: 3 as const } };
    // On high-density screens chroma is already finer than the eye resolves; 4:4:4 only pays off at 1x.
    const subsampling = q >= 80 && this.prefs().dpr < 1.5 ? "4:4:4" : "4:2:0";
    let bytes = 0;
    let pixels = 0;
    const out = await Promise.all(
      rects.map(async (r) => {
        let pipeline = sharp(raw.buf, input).extract({ left: r.x, top: r.y, width: r.w, height: r.h });
        if (s < 1) pipeline = pipeline.resize(Math.max(1, Math.round(r.w * s)), Math.max(1, Math.round(r.h * s)), { kernel: "linear" });
        const data = await pipeline.jpeg({ quality: q, chromaSubsampling: subsampling }).toBuffer();
        bytes += data.length;
        pixels += r.w * r.h;
        return { ...r, data };
      }),
    );
    if (pixels > 20000) {
      const observed = bytes / (pixels * s * s);
      const prev = this.bpp.get(q) ?? observed;
      this.bpp.set(q, prev * 0.7 + observed * 0.3);
    }
    return out;
  }

  private sendPacket(p: { w: number; h: number; dy: number; scrollY: number | null; inputSeq: number; flags: number; rects: Encoded[] }) {
    const body = p.rects.reduce((sum, r) => sum + 12 + r.data.length, 0);
    const buf = Buffer.allocUnsafe(HEADER + body);
    const seq = ++this.seq;
    buf.writeUInt8(2, 0);
    buf.writeUInt32BE(seq >>> 0, 1);
    buf.writeUInt16BE(p.w, 5);
    buf.writeUInt16BE(p.h, 7);
    buf.writeInt16BE(Math.max(-32768, Math.min(32767, p.dy)), 9);
    buf.writeInt32BE(p.scrollY === null ? -1 : Math.max(0, Math.round(p.scrollY)), 11);
    buf.writeInt32BE(Math.round(this.prefs().maxScrollY), 15);
    buf.writeUInt32BE(p.inputSeq >>> 0, 19);
    buf.writeUInt8(p.flags, 23);
    buf.writeUInt16BE(p.rects.length, 24);
    let off = HEADER;
    for (const r of p.rects) {
      buf.writeUInt16BE(r.x, off);
      buf.writeUInt16BE(r.y, off + 2);
      buf.writeUInt16BE(r.w, off + 4);
      buf.writeUInt16BE(r.h, off + 6);
      buf.writeUInt32BE(r.data.length, off + 8);
      r.data.copy(buf, off + 12);
      off += 12 + r.data.length;
    }
    const now = Date.now();
    this.inflight.set(seq, {
      bytes: buf.length,
      sentAt: now,
      delivered: this.delivered,
      deliveredAt: this.inflight.size === 0 ? now : this.lastAckAt || now,
    });
    this.inflightBytes += buf.length;
    this.send(buf);
  }

  /* ---------------- refinement ---------------- */

  private scheduleRefine() {
    if (this.refineTimer) clearTimeout(this.refineTimer);
    if (!this.lowq || !this.lowq.some((v) => v)) return;
    this.refineTimer = setTimeout(() => void this.refine(), REFINE_DELAY);
  }

  /** Re-sends low-quality regions crisp, in bandwidth-sized chunks so new motion is never stuck behind it. */
  private async refine() {
    this.refineTimer = null;
    if (this.closed || !this.ref || !this.lowq) return;
    if (this.busy || this.latest) return; // a newer frame is coming; it will reschedule
    if (!this.canSend()) {
      this.refineTimer = setTimeout(() => void this.refine(), 60);
      return;
    }
    const ref = this.ref;
    const lowq = this.lowq;
    const cols = Math.ceil(ref.w / TILE);
    const rows = Math.ceil(ref.h / TILE);
    const all = mergeRects(lowq, cols, rows, ref.w, ref.h);
    if (!all.length) return;

    const preferred = REFINE_Q[this.prefs().quality];
    // On slow links a slightly lighter "crisp" pass arrives much sooner and looks nearly identical.
    const q = this.prefs().quality === "auto" && this.bw < 400_000 ? 76 : preferred;
    const bpp = this.bpp.get(q) ?? 0.085;
    const budget = Math.max(48_000, this.bw * 0.15);
    const chunk: Rect[] = [];
    let estimate = 0;
    for (const r of all) {
      // Split tall rectangles into bands so one chunk never exceeds the budget by much.
      const bandRows = Math.max(1, Math.floor(budget / Math.max(1, r.w * TILE * bpp)));
      for (let y = r.y; y < r.y + r.h && estimate < budget; y += bandRows * TILE) {
        const band = { x: r.x, y, w: r.w, h: Math.min(bandRows * TILE, r.y + r.h - y) };
        chunk.push(band);
        estimate += band.w * band.h * bpp;
      }
      if (estimate >= budget) break;
    }

    this.busy = true;
    try {
      const encoded = await this.encodeRects(ref, chunk, q, 1);
      if (this.closed || this.ref !== ref || this.lowq !== lowq) return; // superseded while encoding
      this.sendPacket({ w: ref.w, h: ref.h, dy: 0, scrollY: ref.scrollY, inputSeq: 0, flags: 2, rects: encoded });
      for (const r of chunk) markTiles(lowq, cols, r, 0);
    } finally {
      this.busy = false;
      if (lowq.some((v) => v)) this.refineTimer = setTimeout(() => void this.refine(), 30);
      this.pump();
    }
  }
}

/* ------------------------------------------------------------------ */

function markTiles(flags: Uint8Array, cols: number, r: Rect, value: number) {
  const tx0 = Math.floor(r.x / TILE);
  const ty0 = Math.floor(r.y / TILE);
  const tx1 = Math.ceil((r.x + r.w) / TILE);
  const ty1 = Math.ceil((r.y + r.h) / TILE);
  for (let ty = ty0; ty < ty1; ty += 1) for (let tx = tx0; tx < tx1; tx += 1) flags[ty * cols + tx] = value;
}

/** Merge dirty tiles into a small number of rectangles (row runs, then vertical merge). */
function mergeRects(dirty: Uint8Array, cols: number, rows: number, w: number, h: number): Rect[] {
  type Span = { x0: number; x1: number; y0: number; y1: number };
  const done: Span[] = [];
  let open: Span[] = [];
  for (let ty = 0; ty < rows; ty += 1) {
    const runs: [number, number][] = [];
    let tx = 0;
    while (tx < cols) {
      if (!dirty[ty * cols + tx]) {
        tx += 1;
        continue;
      }
      let end = tx + 1;
      // Bridge single clean gaps to keep the rectangle count low.
      while (end < cols && (dirty[ty * cols + end] || (end + 1 < cols && dirty[ty * cols + end + 1]))) end += 1;
      runs.push([tx, end]);
      tx = end;
    }
    const nextOpen: Span[] = [];
    for (const [a, b] of runs) {
      const i = open.findIndex((r) => r.x0 === a && r.x1 === b);
      if (i >= 0) {
        const r = open[i];
        r.y1 = ty + 1;
        nextOpen.push(r);
        open.splice(i, 1);
      } else {
        nextOpen.push({ x0: a, x1: b, y0: ty, y1: ty + 1 });
      }
    }
    done.push(...open);
    open = nextOpen;
  }
  done.push(...open);
  let rects = done.map((r) => ({ x: r.x0 * TILE, y: r.y0 * TILE, w: Math.min(w, r.x1 * TILE) - r.x0 * TILE, h: Math.min(h, r.y1 * TILE) - r.y0 * TILE }));
  if (rects.length > MAX_RECTS) {
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    const x1 = Math.max(...rects.map((r) => r.x + r.w));
    const y1 = Math.max(...rects.map((r) => r.y + r.h));
    rects = [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }];
  }
  return rects;
}
