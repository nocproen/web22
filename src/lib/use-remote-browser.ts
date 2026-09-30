"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type TranslateInfo = { lang: string; status: "translating" | "done" | "same" | "error"; source: string | null };

export type RemoteTab = {
  id: number;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  translate: TranslateInfo | null;
};

export type ContextInfo = { prevented: boolean; link: string; linkText: string; image: string; selection: string; editable: boolean };

/** One screen update: optional scroll-copy (dy, device px) plus JPEG rectangles to paint. */
export type ScreenPacket = {
  seq: number;
  w: number;
  h: number;
  dy: number;
  scrollY: number | null;
  maxScrollY: number | null;
  inputSeq: number;
  reset: boolean;
  refine: boolean;
  ack: boolean;
  rects: { x: number; y: number; w: number; h: number; blob: Blob }[];
};

/** Root scroll info reported by the server after wheel input was processed. */
export type ScrollInfo = { seq: number; y: number; max: number };

function parsePacket(buffer: ArrayBuffer): ScreenPacket | null {
  const view = new DataView(buffer);
  if (view.byteLength < 26 || view.getUint8(0) !== 2) return null;
  const scrollY = view.getInt32(11);
  const maxScrollY = view.getInt32(15);
  const flags = view.getUint8(23);
  const count = view.getUint16(24);
  const rects: ScreenPacket["rects"] = [];
  let off = 26;
  for (let i = 0; i < count && off + 12 <= view.byteLength; i += 1) {
    const len = view.getUint32(off + 8);
    rects.push({
      x: view.getUint16(off),
      y: view.getUint16(off + 2),
      w: view.getUint16(off + 4),
      h: view.getUint16(off + 6),
      blob: new Blob([new Uint8Array(buffer, off + 12, len)], { type: "image/jpeg" }),
    });
    off += 12 + len;
  }
  return {
    seq: view.getUint32(1),
    w: view.getUint16(5),
    h: view.getUint16(7),
    dy: view.getInt16(9),
    scrollY: scrollY < 0 ? null : scrollY,
    maxScrollY: maxScrollY < 0 ? null : maxScrollY,
    inputSeq: view.getUint32(19),
    reset: (flags & 1) === 1,
    refine: (flags & 2) === 2,
    ack: true,
    rects,
  };
}

export type ClientInput =
  | { type: "move"; x: number; y: number }
  | { type: "down" | "up"; x: number; y: number; button: "left" | "middle" | "right"; clicks: number }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number; seq?: number }
  | { type: "touch"; phase: "start" | "move" | "end" | "cancel"; points: { id: number; x: number; y: number }[]; seq?: number }
  | { type: "press"; key: string }
  | { type: "text"; text: string };

export type ConnectionStatus = "connecting" | "preparing" | "ready" | "reconnecting" | "busy" | "ended" | "error";
export type QueueInfo = { active: number; limit: number; retryAt: number };
export type Quality = "auto" | "smooth" | "balanced" | "sharp";
export type Transport = "ws" | "sse" | null;

type SessionState = { tabs: RemoteTab[]; activeId: number | null; viewport: { width: number; height: number }; isMobile?: boolean; quality?: Quality; dpr?: number };
export type StreamStats = { rtt: number | null; fps: number; bw: number | null; q: number | null; scale: number };

const SESSION_KEY = "luma_remote_session";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function base64ToBlob(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/jpeg" });
}

export function useRemoteBrowser() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [queue, setQueue] = useState<QueueInfo | null>(null);
  const [message, setMessage] = useState("正在连接远程浏览器…");
  const [tabs, setTabs] = useState<RemoteTab[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [quality, setQualityState] = useState<Quality>("auto");
  const [viewport, setViewport] = useState({ width: 1280, height: 800 });
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const [cursor, setCursor] = useState("default");
  const [transport, setTransport] = useState<Transport>(null);
  const [stats, setStats] = useState<StreamStats>({ rtt: null, fps: 0, bw: null, q: null, scale: 1 });
  const [generation, setGeneration] = useState(0);

  const sessionRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const transportRef = useRef<Transport>(null);
  const frameHandlerRef = useRef<((packet: ScreenPacket) => void) | null>(null);
  const scrollHandlerRef = useRef<((info: ScrollInfo) => void) | null>(null);
  const viewportRef = useRef({ width: 1280, height: 800 });
  const pendingRef = useRef<ClientInput[]>([]);
  const flushTimerRef = useRef<number | null>(null);
  /** Timer ids and rAF handles come from different pools, so remember which one is pending. */
  const flushIsRafRef = useRef(false);
  const inflightRef = useRef(false);
  const toastIdRef = useRef(0);
  const framesRef = useRef(0);

  const showToast = useCallback((text: string) => {
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, message: text });
  }, []);

  const applyState = useCallback((state: SessionState) => {
    setTabs(state.tabs);
    setActiveId(state.activeId);
    if (state.quality) setQualityState(state.quality);
    if (state.viewport) setViewport((current) => (current.width === state.viewport.width && current.height === state.viewport.height ? current : state.viewport));
  }, []);

  const deliverFrame = useCallback((packet: ScreenPacket) => {
    framesRef.current += 1;
    frameHandlerRef.current?.(packet);
  }, []);

  const handleCopied = useCallback((text: string | undefined) => {
    if (text) navigator.clipboard?.writeText(text).catch(() => {});
  }, []);

  /* ---------------- connection lifecycle ---------------- */
  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    let ws: WebSocket | null = null;
    let wsUnsupported = false;
    let ended = false;
    let pingTimer: number | undefined;

    const setMode = (mode: Transport) => {
      transportRef.current = mode;
      setTransport(mode);
    };

    async function openSession(reset: boolean) {
      setStatus((current) => (current === "ready" ? "reconnecting" : "connecting"));
      while (!cancelled) {
        const stored = sessionStorage.getItem(SESSION_KEY);
        const content = document.querySelector<HTMLElement>(".browser-content");
        const bounds = content?.getBoundingClientRect();
        if (bounds && bounds.width >= 50 && bounds.height >= 50) {
          viewportRef.current = { width: Math.round(bounds.width), height: Math.round(bounds.height) };
        } else if (window.innerWidth >= 50 && window.innerHeight >= 50 && viewportRef.current.width === 1280) {
          viewportRef.current = { width: window.innerWidth, height: Math.max(240, window.innerHeight - 150) };
        }
        const mobile = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
        const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        const mobilePlatform = ios ? "ios" : "android";
        // Phones can report DPR 3 while rendering a small CSS viewport. A 1.5x
        // remote surface preserves readable text but cuts codec/decode pixels by
        // ~44% compared with a 2x cap on common Retina phones.
        const captureDpr = mobile ? Math.min(window.devicePixelRatio || 1, 1.5) : (window.devicePixelRatio || 1);
        const res = await fetch("/api/rb/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: stored, reset, mobile, mobilePlatform, dpr: captureDpr, ...viewportRef.current }),
        }).catch(() => null);
        reset = false;
        if (cancelled) return null;
        if (!res) {
          setStatus("reconnecting");
          setMessage("网络连接中断，正在重试…");
          await wait(2000);
          continue;
        }
        const data = (await res.json().catch(() => ({}))) as {
          id?: string; state?: SessionState; message?: string; error?: string; busy?: boolean; retryAfter?: number; active?: number; limit?: number;
        };
        if (res.status === 503 && data.busy) {
          // Server full: wait in line. The server frees idle sessions, so retry when one should become free.
          const delay = Math.min(15, Math.max(3, data.retryAfter ?? 5)) * 1000;
          setStatus("busy");
          setMessage(data.message ?? "服务器当前使用人数已满，正在排队…");
          setQueue({ active: data.active ?? 0, limit: data.limit ?? 0, retryAt: Date.now() + delay });
          await wait(delay);
          continue;
        }
        setQueue(null);
        if (res.status === 202) {
          setStatus("preparing");
          setMessage(data.message ?? "正在启动浏览器引擎…");
          await wait(1500);
          continue;
        }
        if (!res.ok || !data.id || !data.state) {
          setStatus("error");
          setMessage(data.error ?? "无法创建浏览器会话，正在重试…");
          await wait(5000);
          continue;
        }
        sessionStorage.setItem(SESSION_KEY, data.id);
        sessionRef.current = data.id;
        applyState(data.state);
        // The container may have been measured while the session was still being created
        // (or this is a reused session from another window size): make the remote viewport match exactly.
        const wanted = viewportRef.current;
        if (data.state.viewport.width !== wanted.width || data.state.viewport.height !== wanted.height) {
          await fetch("/api/rb/command", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session: data.id, action: "resize", ...wanted }),
          }).catch(() => null);
        }
        return data.id;
      }
      return null;
    }

    /** The server closed our session on purpose: stop, explain, and let the user start again. */
    const endSession = (message: string) => {
      if (cancelled) return;
      ended = true;
      sessionStorage.removeItem(SESSION_KEY);
      sessionRef.current = null;
      window.clearInterval(pingTimer);
      setTabs([]);
      setActiveId(null);
      setStatus("ended");
      setMessage(message || "浏览器会话已结束");
    };

    const retry = (reset: boolean, delay = 1000) => {
      void wait(delay).then(() => {
        if (!cancelled) void connect(reset);
      });
    };

    /** Preferred transport. Resolves false if WebSocket can't be established. */
    function connectWs(id: string) {
      return new Promise<boolean>((resolve) => {
        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        const socket = new WebSocket(`${protocol}://${window.location.host}/api/rb/ws?session=${encodeURIComponent(id)}`);
        socket.binaryType = "arraybuffer";
        let opened = false;
        const giveUp = window.setTimeout(() => {
          if (!opened) {
            socket.close();
            resolve(false);
          }
        }, 5000);

        socket.onopen = () => {
          opened = true;
          window.clearTimeout(giveUp);
          ws = socket;
          wsRef.current = socket;
          setMode("ws");
          setStatus("ready");
          setMessage("");
          const ping = () => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ t: "ping", ts: performance.now() }));
          ping();
          window.clearInterval(pingTimer);
          pingTimer = window.setInterval(ping, 3000);
          resolve(true);
        };

        socket.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            const packet = parsePacket(event.data);
            if (packet) deliverFrame(packet);
            return;
          }
          let msg: { t: string; d: unknown };
          try {
            msg = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (msg.t === "state") applyState(msg.d as SessionState);
          else if (msg.t === "toast") showToast((msg.d as { message: string }).message);
          else if (msg.t === "cursor") setCursor((msg.d as { cursor: string }).cursor);
          else if (msg.t === "copied") handleCopied((msg.d as { text: string }).text);
          else if (msg.t === "scroll") scrollHandlerRef.current?.(msg.d as ScrollInfo);
          else if (msg.t === "closed") endSession((msg.d as { message?: string }).message ?? "");
          else if (msg.t === "stats") {
            const d = msg.d as { bw: number; q: number; scale: number };
            setStats((current) => ({ ...current, bw: d.bw, q: d.q || current.q, scale: d.scale }));
          }
          else if (msg.t === "pong") {
            const rtt = Math.round(performance.now() - (msg.d as { ts: number }).ts);
            setStats((current) => ({ ...current, rtt }));
          }
        };

        socket.onclose = (event) => {
          window.clearTimeout(giveUp);
          if (!opened) {
            resolve(false);
            return;
          }
          if (wsRef.current === socket) wsRef.current = null;
          ws = null;
          window.clearInterval(pingTimer);
          if (cancelled || ended) return;
          if (event.code === 4410) {
            endSession("浏览器会话已结束");
            return;
          }
          setStatus("reconnecting");
          setMessage("连接已断开，正在恢复…");
          if (event.code === 4404) sessionRef.current = null;
          retry(false);
        };
      });
    }

    /** Fallback transport: Server-Sent Events + HTTP input. */
    function connectSse(id: string) {
      setMode("sse");
      source = new EventSource(`/api/rb/stream?session=${encodeURIComponent(id)}`);
      source.addEventListener("state", (event) => applyState(JSON.parse((event as MessageEvent).data) as SessionState));
      source.addEventListener("frame", (event) => {
        const frame = JSON.parse((event as MessageEvent).data) as { seq: number; w: number; h: number; data: string };
        deliverFrame({
          seq: frame.seq, w: frame.w, h: frame.h, dy: 0, scrollY: null, maxScrollY: null, inputSeq: 0, reset: false, refine: false, ack: false,
          rects: [{ x: 0, y: 0, w: frame.w, h: frame.h, blob: base64ToBlob(frame.data) }],
        });
      });
      source.addEventListener("toast", (event) => showToast((JSON.parse((event as MessageEvent).data) as { message: string }).message));
      source.addEventListener("closed", (event) => {
        source?.close();
        source = null;
        endSession((JSON.parse((event as MessageEvent).data) as { message?: string }).message ?? "");
      });
      source.addEventListener("cursor", (event) => setCursor((JSON.parse((event as MessageEvent).data) as { cursor: string }).cursor));
      source.addEventListener("scroll", (event) => scrollHandlerRef.current?.(JSON.parse((event as MessageEvent).data) as ScrollInfo));
      source.onopen = () => {
        setStatus("ready");
        setMessage("");
      };
      source.onerror = () => {
        if (cancelled || ended || !source) return;
        if (source.readyState === EventSource.CLOSED) {
          source.close();
          source = null;
          sessionRef.current = null;
          setStatus("reconnecting");
          setMessage("连接已断开，正在恢复…");
          retry(false);
        } else {
          setStatus("reconnecting");
          setMessage("连接不稳定，正在重连…");
        }
      };
    }

    async function connect(reset: boolean) {
      const id = await openSession(reset);
      if (!id || cancelled) return;
      if (!wsUnsupported) {
        const ok = await connectWs(id);
        if (cancelled) return;
        if (ok) return;
        wsUnsupported = true;
      }
      connectSse(id);
    }

    void connect(generation > 0);

    const fpsTimer = window.setInterval(() => {
      const fps = framesRef.current;
      framesRef.current = 0;
      setStats((current) => (current.fps === fps ? current : { ...current, fps }));
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(fpsTimer);
      window.clearInterval(pingTimer);
      source?.close();
      ws?.close();
      wsRef.current = null;
    };
  }, [applyState, deliverFrame, handleCopied, showToast, generation]);

  /** Called by the screen after a frame has been painted: releases the next one. */
  const frameDrawn = useCallback((seq: number) => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "ack", seq }));
  }, []);

  /* ---------------- commands ---------------- */
  const command = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    const session = sessionRef.current;
    if (!session) return null;
    const res = await fetch("/api/rb/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, action, ...extra }),
    }).catch(() => null);
    return res ? res.json().catch(() => null) : null;
  }, []);

  const resetSession = useCallback(() => {
    setStatus("connecting");
    setMessage("正在连接远程浏览器…");
    sessionRef.current = null;
    setTabs([]);
    setActiveId(null);
    setGeneration((value) => value + 1);
  }, []);

  const resize = useCallback((width: number, height: number) => {
    viewportRef.current = { width, height };
    // Without a session yet, the size is applied right after the session is created.
    if (sessionRef.current) void command("resize", { width, height });
  }, [command]);

  const setQuality = useCallback((next: Quality) => {
    setQualityState(next);
    void command("quality", { quality: next });
  }, [command]);

  /* ---------------- input ---------------- */
  const flushHttp = useCallback(async () => {
    const session = sessionRef.current;
    if (inflightRef.current || !session || pendingRef.current.length === 0) return;
    inflightRef.current = true;
    const events = pendingRef.current.splice(0);
    try {
      const res = await fetch("/api/rb/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, events }),
      });
      const data = (await res.json().catch(() => ({}))) as { copied?: string };
      handleCopied(data.copied);
    } catch {
      /* dropped input is acceptable */
    } finally {
      inflightRef.current = false;
      if (pendingRef.current.length) void flushHttp();
    }
  }, [handleCopied]);

  const flush = useCallback(() => {
    if (flushTimerRef.current !== null) {
      if (flushIsRafRef.current) window.cancelAnimationFrame(flushTimerRef.current);
      else window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const socket = wsRef.current;
    if (transportRef.current === "ws" && socket?.readyState === WebSocket.OPEN) {
      if (!pendingRef.current.length) return;
      socket.send(JSON.stringify({ t: "input", events: pendingRef.current.splice(0) }));
    } else {
      void flushHttp();
    }
  }, [flushHttp]);

  const sendInput = useCallback((event: ClientInput) => {
    const queue = pendingRef.current;
    const last = queue[queue.length - 1];
    if (event.type === "move" && last?.type === "move") queue[queue.length - 1] = event;
    else if (event.type === "wheel" && last?.type === "wheel") queue[queue.length - 1] = { ...event, dx: last.dx + event.dx, dy: last.dy + event.dy };
    else if (event.type === "touch" && event.phase === "move" && last?.type === "touch" && last.phase === "move") queue[queue.length - 1] = event;
    else queue.push(event);

    // Clicks, gesture boundaries, and keys go out immediately. High-frequency
    // motion is coalesced onto the display's refresh cadence.
    const motion = event.type === "move" || event.type === "wheel" || (event.type === "touch" && event.phase === "move");
    if (!motion) flush();
    else if (flushTimerRef.current === null) {
      const useRaf = typeof window.requestAnimationFrame === "function";
      flushIsRafRef.current = useRaf;
      flushTimerRef.current = useRaf ? window.requestAnimationFrame(() => flush()) : window.setTimeout(flush, 16);
    }
  }, [flush]);

  return {
    status,
    message,
    queue,
    showToast,
    tabs,
    activeId,
    setActiveId,
    toast,
    cursor,
    transport,
    stats,
    quality,
    viewport,
    setQuality,
    command,
    resize,
    sendInput,
    resetSession,
    frameDrawn,
    frameHandlerRef,
    scrollHandlerRef,
    viewportRef,
  };
}
