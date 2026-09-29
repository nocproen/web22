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
  viewport: { width: number; height: number };
  cursor: string;
  hidden: boolean;
  focusSignal: number;
};

function mapButton(button: number): "left" | "middle" | "right" {
  return button === 1 ? "middle" : button === 2 ? "right" : "left";
}

export function RemoteScreen({ frameHandlerRef, scrollHandlerRef, sendInput, onResize, onFrameDrawn, onContextMenu, viewport, cursor, hidden, focusSignal }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const viewportRef = useRef(viewport);
  const composingRef = useRef(false);
  const clickRef = useRef({ time: 0, x: 0, y: 0, count: 0 });
  const touchRef = useRef<{ id: number; x: number; y: number; startX: number; startY: number; moved: boolean; longPress: boolean; timer: number } | null>(null);

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
  });

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  const applyTransform = useCallback(() => {
    const canvas = canvasRef.current;
    const p = predict.current;
    if (!canvas) return;
    let offset = p.on && p.expected !== null && p.base !== null ? p.expected - p.base : 0;
    const limit = viewportRef.current.height;
    offset = Math.max(-limit, Math.min(limit, offset));
    canvas.style.transform = offset ? `translate3d(0, ${-offset}px, 0)` : "";
  }, []);

  const resync = useCallback((y: number) => {
    const p = predict.current;
    // If we predicted movement but the root didn't scroll, the wheel went to an inner
    // scroller (map, chat pane…): stop predicting until the root scrolls again.
    if (p.sinceSync !== 0) p.on = Math.abs(y - p.syncY) >= 1;
    p.expected = y;
    p.syncY = y;
    p.sinceSync = 0;
  }, []);

  /* ---------------- screen packets (strictly in order) ---------------- */
  useEffect(() => {
    let chain: Promise<void> = Promise.resolve();
    let disposed = false;

    const apply = async (packet: ScreenPacket) => {
      const bitmaps = await Promise.all(packet.rects.map((r) => createImageBitmap(r.blob).catch(() => null)));
      const canvas = canvasRef.current;
      if (disposed || !canvas) {
        bitmaps.forEach((b) => b?.close());
        return;
      }
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return;
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
      }
      // Scroll copy: shift what we already have, then paint only the changed rectangles.
      if (packet.dy) ctx.drawImage(canvas, 0, -packet.dy);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      packet.rects.forEach((r, i) => {
        const bitmap = bitmaps[i];
        if (!bitmap) return;
        ctx.drawImage(bitmap, r.x, r.y, r.w, r.h);
        bitmap.close();
      });

      if (packet.maxScrollY !== null) p.max = packet.maxScrollY;
      if (!packet.refine && packet.scrollY !== null) {
        p.base = packet.scrollY;
        if (p.expected === null) {
          p.expected = packet.scrollY;
          p.syncY = packet.scrollY;
          p.sinceSync = 0;
        } else if (packet.inputSeq >= p.lastSent) {
          resync(packet.scrollY);
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
      // Every wheel was handled and the root didn't move (bottom of page / inner scroller): drop the prediction.
      if (info.seq >= p.lastSent && p.base !== null && Math.abs(info.y - p.base) < 1) resync(info.y);
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
      }, 220);
    });
    observer.observe(wrap);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [onResize]);

  useEffect(() => {
    if (!hidden && focusSignal > 0) inputRef.current?.focus({ preventScroll: true });
  }, [focusSignal, hidden]);

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
    if (p.expected !== null && dy) {
      let next = Math.max(0, p.expected + dy);
      if (p.max !== null) next = Math.min(next, p.max);
      p.sinceSync += next - p.expected;
      p.expected = next;
      applyTransform();
    }
    sendInput({ type: "wheel", x, y, dx, dy, seq: p.seq });
  }, [sendInput, applyTransform]);

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

  /* ---------------- pointer ---------------- */
  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.target === inputRef.current) return;
    event.preventDefault();
    inputRef.current?.focus({ preventScroll: true });
    placeImeAnchor(event.clientX, event.clientY);
    const { x, y } = point(event.clientX, event.clientY);
    if (event.pointerType === "touch") {
      const { clientX, clientY, pointerId } = event;
      if (touchRef.current) window.clearTimeout(touchRef.current.timer);
      // Long press = right-click on touch screens.
      const timer = window.setTimeout(() => {
        const touch = touchRef.current;
        if (!touch || touch.id !== pointerId || touch.moved) return;
        touch.longPress = true;
        onContextMenu({ x, y, clientX, clientY });
      }, 550);
      touchRef.current = { id: pointerId, x: clientX, y: clientY, startX: clientX, startY: clientY, moved: false, longPress: false, timer };
      return;
    }
    if (event.button === 2) {
      // Our own menu replaces the (invisible) native one; the server still delivers the click to the page.
      onContextMenu({ x, y, clientX: event.clientX, clientY: event.clientY });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const now = performance.now();
    const c = clickRef.current;
    const count = now - c.time < 450 && Math.abs(c.x - x) < 6 && Math.abs(c.y - y) < 6 ? Math.min(3, c.count + 1) : 1;
    clickRef.current = { time: now, x, y, count };
    sendInput({ type: "down", x, y, button: mapButton(event.button), clicks: count });
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "touch") {
      const touch = touchRef.current;
      if (!touch || touch.id !== event.pointerId) return;
      const dx = touch.x - event.clientX;
      const dy = touch.y - event.clientY;
      if (Math.abs(event.clientX - touch.startX) > 8 || Math.abs(event.clientY - touch.startY) > 8) {
        touch.moved = true;
        window.clearTimeout(touch.timer);
      }
      if (touch.longPress) return;
      touch.x = event.clientX;
      touch.y = event.clientY;
      const { x, y } = point(event.clientX, event.clientY);
      if (touch.moved) sendWheel(x, y, dx, dy);
      return;
    }
    const { x, y } = point(event.clientX, event.clientY);
    sendInput({ type: "move", x, y });
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const { x, y } = point(event.clientX, event.clientY);
    if (event.pointerType === "touch") {
      const touch = touchRef.current;
      touchRef.current = null;
      if (touch) window.clearTimeout(touch.timer);
      if (touch && !touch.moved && !touch.longPress) {
        sendInput({ type: "move", x, y });
        sendInput({ type: "down", x, y, button: "left", clicks: 1 });
        sendInput({ type: "up", x, y, button: "left", clicks: 1 });
      }
      return;
    }
    if (event.button === 2) return;
    sendInput({ type: "up", x, y, button: mapButton(event.button), clicks: clickRef.current.count });
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
      onPointerCancel={() => {
        touchRef.current = null;
      }}
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
