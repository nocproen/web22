"use client";

import { MutableRefObject, useCallback, useEffect, useRef } from "react";
import type { ClientInput, ScreenPacket, ScrollInfo } from "@/lib/use-remote-browser";

const SPECIAL_KEYS = new Set([
  "Enter", "Backspace", "Tab", "Escape", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
]);

const SAFE_CURSORS = new Set([
  "default", "pointer", "text", "move", "grab", "grabbing", "crosshair", "not-allowed", "wait", "progress", "help",
  "col-resize", "row-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "zoom-in", "zoom-out", "vertical-text", "cell", "copy", "alias", "context-menu", "all-scroll", "none",
]);

type Props = {
  frameHandlerRef: MutableRefObject<((packet: ScreenPacket) => void) | null>;
  scrollHandlerRef: MutableRefObject<((info: ScrollInfo) => void) | null>;
  sendInput: (event: ClientInput) => void;
  onResize: (width: number, height: number) => void;
  onFrameDrawn: (seq: number) => void;
  onContextMenu: (at: { x: number; y: number; clientX: number; clientY: number }) => void;
  keyboardFocusRef: MutableRefObject<(() => void) | null>;
  viewport: { width: number; height: number };
  cursor: string;
  hidden: boolean;
  focusSignal: number;
};

function mapButton(button: number): "left" | "middle" | "right" {
  return button === 1 ? "middle" : button === 2 ? "right" : "left";
}

/** True once the wheel has been quiet long enough that server reports are trustworthy. */
const SETTLE_MS = 120;
const settled = (p: { lastWheelAt: number }) => Date.now() - p.lastWheelAt > SETTLE_MS;

type DecodedImage = { image: CanvasImageSource; width: number; height: number; close: () => void };

async function decodeImageBlob(blob: Blob): Promise<DecodedImage | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Safari versions without complete ImageBitmap support use the HTMLImage fallback below.
    }
  }

  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    if (typeof image.decode === "function") await image.decode();
    else await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Unable to decode remote frame"));
    });
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => { URL.revokeObjectURL(url); image.removeAttribute("src"); },
    };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

export function RemoteScreen({ frameHandlerRef, scrollHandlerRef, sendInput, onResize, onFrameDrawn, onContextMenu, keyboardFocusRef, viewport, cursor, hidden, focusSignal }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const viewportRef = useRef(viewport);
  const composingRef = useRef(false);
  const clickRef = useRef({ time: 0, x: 0, y: 0, count: 0 });
  const touchRef = useRef<{ id: number; x: number; y: number; startX: number; startY: number; moved: boolean; longPress: boolean; timer: number; lastAt: number; velocityX: number; velocityY: number } | null>(null);
  const touchPointsRef = useRef(new Map<number, { clientX: number; clientY: number }>());
  const pinchRef = useRef<{ ids: number[]; active: boolean; released: Set<number> } | null>(null);
  const inertiaRef = useRef<number | null>(null);

  // Local scroll prediction: the picture moves immediately, the server's frames confirm it.
  const predict = useRef({
    expected: null as number | null, // root scrollY we expect once all sent wheels are processed (CSS px)
    base: null as number | null, // root scrollY of the picture currently on the canvas
    max: null as number | null,
    lastSent: 0,
    seq: 0,
    on: true,
    syncY: 0,
    sinceSync: 0,
    lastWheelAt: 0,
    pendingY: null as number | null,
    written: NaN,
  });
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  const writeTransform = useCallback(() => {
    rafRef.current = null;
    const canvas = canvasRef.current;
    const p = predict.current;
    if (!canvas) return;
    let offset = p.on && p.expected !== null && p.base !== null ? p.expected - p.base : 0;
    const limit = viewportRef.current.height;
    offset = Math.max(-limit, Math.min(limit, offset));
    if (offset === p.written) return; // same position; skip the style write entirely
    p.written = offset;
    canvas.style.transform = offset ? `translate3d(0, ${-offset}px, 0)` : "";
  }, []);

  /**
   * A wheel burst fires many events per displayed frame. Writing `transform` on
   * each one just queues redundant style invalidations, so the picture is moved
   * once per frame, on the frame boundary.
   */
  const applyTransform = useCallback(() => {
    if (rafRef.current !== null) return;
    if (typeof window.requestAnimationFrame !== "function") {
      writeTransform();
      return;
    }
    rafRef.current = window.requestAnimationFrame(writeTransform);
  }, [writeTransform]);

  const stopInertia = useCallback(() => {
    if (inertiaRef.current !== null) window.cancelAnimationFrame(inertiaRef.current);
    inertiaRef.current = null;
  }, []);

  useEffect(() => () => {
    if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    if (inertiaRef.current !== null) window.cancelAnimationFrame(inertiaRef.current);
    if (touchRef.current) window.clearTimeout(touchRef.current.timer);
  }, []);

  const resync = useCallback((y: number) => {
    const p = predict.current;
    // If we predicted movement but the root didn't scroll, the wheel went to an inner
    // scroller (map, chat pane…): stop predicting until the root scrolls again.
    if (p.sinceSync !== 0) p.on = Math.abs(y - p.syncY) >= 1;
    p.expected = y;
    p.syncY = y;
    p.sinceSync = 0;
    p.pendingY = null;
  }, []);

  /* ---------------- screen packets (strictly in order) ---------------- */
  useEffect(() => {
    let chain: Promise<void> = Promise.resolve();
    let disposed = false;

    const apply = async (packet: ScreenPacket) => {
      const bitmaps = await Promise.all(packet.rects.map((r) => decodeImageBlob(r.blob)));
      const canvas = canvasRef.current;
      if (disposed || !canvas) {
        bitmaps.forEach((b) => b?.close());
        return;
      }
      const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
      if (!ctx) {
        bitmaps.forEach((b) => b?.close());
        return;
      }
      const p = predict.current;
      if (packet.reset || canvas.width !== packet.w || canvas.height !== packet.h) {
        canvas.width = packet.w;
        canvas.height = packet.h;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, packet.w, packet.h);
        if (packet.reset) {
          p.expected = null;
          p.base = null;
          p.sinceSync = 0;
          p.on = true;
        }
        p.written = NaN; // force the next transform write; the canvas was reallocated
      }
      // Scroll copy is an integer-pixel, 1:1 move. Disable interpolation for
      // this path; only motion patches encoded below native resolution need it.
      if (packet.dy) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(canvas, 0, -packet.dy);
      }
      packet.rects.forEach((r, i) => {
        const bitmap = bitmaps[i];
        if (!bitmap) return;
        const scaled = bitmap.width !== r.w || bitmap.height !== r.h;
        ctx.imageSmoothingEnabled = scaled;
        if (scaled) ctx.imageSmoothingQuality = "medium";
        ctx.drawImage(bitmap.image, r.x, r.y, r.w, r.h);
        bitmap.close();
      });
      ctx.imageSmoothingEnabled = false;

      if (packet.maxScrollY !== null) p.max = packet.maxScrollY;
      if (!packet.refine && packet.scrollY !== null) {
        p.base = packet.scrollY;
        if (p.expected === null) {
          p.expected = packet.scrollY;
          p.syncY = packet.scrollY;
          p.sinceSync = 0;
        } else if (packet.inputSeq >= p.lastSent) {
          if (settled(p)) {
            // Mid-flick a frame can be tagged with input it does not show yet.
            // Trust reports only after the gesture/inertia has settled.
            resync(packet.scrollY);
          } else {
            p.pendingY = packet.scrollY;
          }
        }
      }
      applyTransform();
      if (packet.ack) onFrameDrawn(packet.seq);
    };

    frameHandlerRef.current = (packet) => {
      chain = chain.then(() => apply(packet)).catch(() => {});
    };
    scrollHandlerRef.current = (info) => {
      const p = predict.current;
      if (info.max >= 0) p.max = info.max;
      if (info.seq >= p.lastSent && p.expected !== null) {
        if (settled(p)) resync(info.y);
        else p.pendingY = info.y;
      }
      applyTransform();
    };
    return () => {
      disposed = true;
      frameHandlerRef.current = null;
      scrollHandlerRef.current = null;
    };
  }, [frameHandlerRef, scrollHandlerRef, onFrameDrawn, applyTransform, resync]);

  /* ---------------- viewport size ---------------- */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let timer: number | undefined;
    let last = "";
    const initial = wrap.getBoundingClientRect();
    if (initial.width >= 50 && initial.height >= 50) {
      last = `${Math.floor(initial.width)}x${Math.floor(initial.height)}`;
      onResize(Math.floor(initial.width), Math.floor(initial.height));
    }
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      if (width < 50 || height < 50) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const key = `${width}x${height}`;
        if (key === last) return;
        last = key;
        onResize(width, height);
      }, 100);
    });
    observer.observe(wrap);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [onResize]);

  useEffect(() => {
    const touchDevice = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
    if (!touchDevice && !hidden && focusSignal > 0) inputRef.current?.focus({ preventScroll: true });
  }, [focusSignal, hidden]);

  useEffect(() => {
    keyboardFocusRef.current = () => {
      if (!hidden) inputRef.current?.focus({ preventScroll: true });
    };
    return () => {
      keyboardFocusRef.current = null;
    };
  }, [keyboardFocusRef, hidden]);

  /* ---------------- coordinate mapping (remote CSS px) ---------------- */
  // Uses the container, not the (possibly prediction-shifted) canvas: once queued wheels
  // are processed the remote page is exactly where the user sees it.
  function point(clientX: number, clientY: number) {
    const wrap = wrapRef.current;
    const { width, height } = viewportRef.current;
    if (!wrap) return { x: 0, y: 0 };
    const rect = wrap.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(width - 1, ((clientX - rect.left) / rect.width) * width)),
      y: Math.max(0, Math.min(height - 1, ((clientY - rect.top) / rect.height) * height)),
    };
  }

  function placeImeAnchor(clientX: number, clientY: number) {
    const wrap = wrapRef.current;
    const input = inputRef.current;
    if (!wrap || !input) return;
    const rect = wrap.getBoundingClientRect();
    input.style.left = `${clientX - rect.left}px`;
    input.style.top = `${clientY - rect.top}px`;
  }

  const sendWheel = useCallback((x: number, y: number, dx: number, dy: number) => {
    const p = predict.current;
    p.seq += 1;
    p.lastSent = p.seq;
    p.lastWheelAt = Date.now();
    p.pendingY = null;
    if (p.expected !== null && dy) {
      let next = Math.max(0, p.expected + dy);
      if (p.max !== null) next = Math.min(next, p.max);
      p.sinceSync += next - p.expected;
      p.expected = next;
      applyTransform();
    }
    sendInput({ type: "wheel", x, y, dx, dy, seq: p.seq });
  }, [sendInput, applyTransform]);

  const startInertia = useCallback((velocityX: number, velocityY: number) => {
    stopInertia();
    // Chromium receives native touch events and performs its own real fling.
    // This is a matching local-only prediction, never extra wheel input, so the
    // remote document cannot scroll twice. The 0.62 factor approximates the
    // measured mobile compositor decay and server frames correct the final offset.
    let vx = Math.max(-1.5, Math.min(1.5, velocityX * 0.62));
    let vy = Math.max(-1.5, Math.min(1.5, velocityY * 0.62));
    if (Math.abs(vx) < 0.04 && Math.abs(vy) < 0.04) return;
    let previous = performance.now();
    let elapsed = 0;
    const step = (now: number) => {
      const dt = Math.min(32, Math.max(8, now - previous));
      previous = now;
      elapsed += dt;
      const p = predict.current;
      const dx = Math.max(-36, Math.min(36, vx * dt));
      const dy = Math.max(-36, Math.min(36, vy * dt));
      if (p.expected !== null && (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05)) {
        let next = p.expected + dy;
        next = Math.max(0, p.max === null ? next : Math.min(p.max, next));
        p.sinceSync += next - p.expected;
        p.expected = next;
        p.lastWheelAt = Date.now();
        applyTransform();
      }
      const decay = Math.exp(-dt / 330);
      vx *= decay;
      vy *= decay;
      if (elapsed < 1350 && (Math.abs(vx) > 0.035 || Math.abs(vy) > 0.035)) {
        inertiaRef.current = window.requestAnimationFrame(step);
      } else {
        inertiaRef.current = null;
        const latest = predict.current;
        latest.lastWheelAt = Date.now() - SETTLE_MS - 1;
        if (latest.pendingY !== null) {
          resync(latest.pendingY);
          applyTransform();
        }
      }
    };
    inertiaRef.current = window.requestAnimationFrame(step);
  }, [applyTransform, resync, stopInertia]);

  /* ---------------- wheel (non-passive) ---------------- */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportRef.current.height : 1;
      const { x, y } = point(event.clientX, event.clientY);
      sendWheel(x, y, event.deltaX * scale, event.deltaY * scale);
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendWheel]);

  /* ---------------- pointer / touch gestures ---------------- */
  function sendPinch(phase: "start" | "move" | "end" | "cancel", ids: number[], scrollDelta?: { dx: number; dy: number }) {
    const points = ids.flatMap((id, index) => {
      const current = touchPointsRef.current.get(id);
      if (!current) return [];
      const { x, y } = point(current.clientX, current.clientY);
      return [{ id: index, x, y }];
    });
    const p = predict.current;
    p.seq += 1;
    p.lastSent = p.seq;
    p.lastWheelAt = Date.now();
    p.pendingY = null;
    if (scrollDelta?.dy && p.expected !== null) {
      let next = Math.max(0, p.expected + scrollDelta.dy);
      if (p.max !== null) next = Math.min(next, p.max);
      p.sinceSync += next - p.expected;
      p.expected = next;
      applyTransform();
    }
    sendInput({ type: "touch", phase, points: phase === "end" || phase === "cancel" ? [] : points, seq: p.seq });
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.target === inputRef.current) return;
    event.preventDefault();
    const { x, y } = point(event.clientX, event.clientY);
    if (event.pointerType === "touch") {
      stopInertia();
      const { clientX, clientY, pointerId } = event;
      try { event.currentTarget.setPointerCapture(pointerId); } catch { /* older mobile browsers */ }
      touchPointsRef.current.set(pointerId, { clientX, clientY });

      if (pinchRef.current) return;
      const active = touchRef.current;
      if (active) {
        window.clearTimeout(active.timer);
        active.moved = true;
        const ids = [active.id, pointerId];
        pinchRef.current = { ids, active: true, released: new Set() };
        sendPinch("start", ids);
        return;
      }

      const now = performance.now();
      // Long press = right-click on touch screens. Tapping does not summon the
      // phone keyboard; the explicit keyboard control does that on demand.
      const timer = window.setTimeout(() => {
        const touch = touchRef.current;
        if (!touch || touch.id !== pointerId || touch.moved) return;
        touch.longPress = true;
        sendPinch("cancel", []);
        onContextMenu({ x, y, clientX, clientY });
      }, 550);
      touchRef.current = { id: pointerId, x: clientX, y: clientY, startX: clientX, startY: clientY, moved: false, longPress: false, timer, lastAt: now, velocityX: 0, velocityY: 0 };
      sendPinch("start", [pointerId]);
      return;
    }

    inputRef.current?.focus({ preventScroll: true });
    placeImeAnchor(event.clientX, event.clientY);
    if (event.button === 2) {
      // Our own menu replaces the (invisible) native one; the server still delivers the click to the page.
      onContextMenu({ x, y, clientX: event.clientX, clientY: event.clientY });
      return;
    }
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer capture is optional */ }
    const now = performance.now();
    const c = clickRef.current;
    const count = now - c.time < 450 && Math.abs(c.x - x) < 6 && Math.abs(c.y - y) < 6 ? Math.min(3, c.count + 1) : 1;
    clickRef.current = { time: now, x, y, count };
    sendInput({ type: "down", x, y, button: mapButton(event.button), clicks: count });
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "touch") {
      const pinch = pinchRef.current;
      if (pinch) {
        if (!pinch.active || !pinch.ids.includes(event.pointerId)) return;
        touchPointsRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
        sendPinch("move", pinch.ids);
        return;
      }

      const touch = touchRef.current;
      if (!touch || touch.id !== event.pointerId) return;
      const dx = touch.x - event.clientX;
      const dy = touch.y - event.clientY;
      const now = performance.now();
      const dt = Math.max(8, Math.min(80, now - touch.lastAt));
      if (Math.abs(event.clientX - touch.startX) > 8 || Math.abs(event.clientY - touch.startY) > 8) {
        touch.moved = true;
        window.clearTimeout(touch.timer);
      }
      touch.x = event.clientX;
      touch.y = event.clientY;
      touch.lastAt = now;
      touchPointsRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      if (touch.longPress) return;
      if (touch.moved) {
        // Track velocity in remote page coordinates; a short exponential filter
        // ignores noisy touch samples without making a quick flick feel sluggish.
        touch.velocityX = touch.velocityX * 0.68 + (dx / dt) * 0.32;
        touch.velocityY = touch.velocityY * 0.68 + (dy / dt) * 0.32;
        sendPinch("move", [event.pointerId], { dx, dy });
      }
      return;
    }
    const { x, y } = point(event.clientX, event.clientY);
    sendInput({ type: "move", x, y });
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const { x, y } = point(event.clientX, event.clientY);
    if (event.pointerType === "touch") {
      const pinch = pinchRef.current;
      if (pinch?.ids.includes(event.pointerId)) {
        pinch.released.add(event.pointerId);
        if (pinch.active) sendPinch("end", []);
        pinch.active = false;
        touchPointsRef.current.clear();
        if (touchRef.current) window.clearTimeout(touchRef.current.timer);
        touchRef.current = null;
        if (pinch.released.size >= pinch.ids.length) pinchRef.current = null;
        return;
      }

      const touch = touchRef.current;
      if (!touch || touch.id !== event.pointerId) return;
      touchRef.current = null;
      touchPointsRef.current.delete(event.pointerId);
      window.clearTimeout(touch.timer);
      if (!touch.longPress) {
        // A real touchEnd generates the page's normal click/tap. Do not synthesize
        // mouse down/up too, or touch-capable pages can activate twice.
        sendPinch("end", []);
        if (touch.moved) startInertia(touch.velocityX, touch.velocityY);
      }
      return;
    }
    if (event.button === 2) return;
    sendInput({ type: "up", x, y, button: mapButton(event.button), clicks: clickRef.current.count });
  }

  function onPointerCancel(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    stopInertia();
    const pinch = pinchRef.current;
    if (pinch?.active || (touchRef.current && !touchRef.current.longPress)) sendPinch("cancel", []);
    pinchRef.current = null;
    touchPointsRef.current.clear();
    if (touchRef.current) window.clearTimeout(touchRef.current.timer);
    touchRef.current = null;
  }

  /* ---------------- keyboard / IME ---------------- */
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    const native = event.nativeEvent;
    if (native.isComposing || composingRef.current || event.key === "Process" || native.keyCode === 229) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key;

    if (ctrl && key.toLowerCase() === "v") return; // handled by paste event

    if (!ctrl && key.length === 1) {
      event.preventDefault();
      if (/^[\x20-\x7e]$/.test(key)) sendInput({ type: "press", key });
      else sendInput({ type: "text", text: key });
      return;
    }

    if (SPECIAL_KEYS.has(key) || (ctrl && key.length === 1)) {
      event.preventDefault();
      const mods: string[] = [];
      if (ctrl) mods.push("Control");
      if (event.altKey) mods.push("Alt");
      if (event.shiftKey && (key.length > 1 || ctrl)) mods.push("Shift");
      const main = key.length === 1 ? key.toLowerCase() : key;
      sendInput({ type: "press", key: [...mods, main].join("+") });
    }
  }

  function onCompositionEnd(event: React.CompositionEvent<HTMLTextAreaElement>) {
    composingRef.current = false;
    if (event.data) sendInput({ type: "text", text: event.data });
    event.currentTarget.value = "";
  }

  function onInput(event: React.FormEvent<HTMLTextAreaElement>) {
    // Mobile keyboards often skip keydown for characters; forward whatever landed here.
    if (composingRef.current) return;
    const value = event.currentTarget.value;
    if (value) sendInput({ type: "text", text: value });
    event.currentTarget.value = "";
  }

  function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    event.preventDefault();
    const text = event.clipboardData.getData("text");
    if (text) sendInput({ type: "text", text });
  }

  const cssCursor = SAFE_CURSORS.has(cursor) ? cursor : "default";

  return (
    <div
      ref={wrapRef}
      className={`remote-screen ${hidden ? "is-hidden" : ""}`}
      style={{ cursor: cssCursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(event) => event.preventDefault()}
      onAuxClick={(event) => event.preventDefault()}
    >
      <canvas ref={canvasRef} className="remote-canvas" width={1280} height={800} />
      <textarea
        ref={inputRef}
        className="remote-input"
        aria-label="远程页面键盘输入"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={onCompositionEnd}
        onInput={onInput}
        onPaste={onPaste}
      />
    </div>
  );
}
