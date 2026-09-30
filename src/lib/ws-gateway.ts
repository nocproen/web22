import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { getSession, type Frame, type SessionEvent } from "./remote-browser";
import { sanitizeEvents } from "./remote-input";
import { ScreenEncoder } from "./screen-encoder";

/**
 * Low-latency transport for the remote browser: one WebSocket per viewer.
 * Screen updates are binary delta packets produced by ScreenEncoder; input
 * arrives on the same ordered connection.
 */

const PATH = "/api/rb/ws";
/** Close code sent when the server closed the session on purpose (idle, reclaimed, crashed). */
export const CLOSE_SESSION_ENDED = 4410;
/** A viewer that hasn't answered a heartbeat for this long is gone (closed tab behind a proxy). */
const DEAD_AFTER_MS = 15_000;

/** Browser WebSockets carry an Origin. Reject cross-site sockets to prevent
 * cross-site WebSocket hijacking if a user ever leaks their bearer session id. */
function sameOriginHost(req: http.IncomingMessage) {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // trusted non-browser/health clients
  if (typeof origin !== "string" || !req.headers.host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host.toLowerCase() === req.headers.host.toLowerCase();
  } catch {
    return false;
  }
}

function handleConnection(ws: WebSocket, req: http.IncomingMessage) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const session = getSession(url.searchParams.get("session"));
  if (!session) {
    ws.close(4404, "session not found");
    return;
  }

  let lastHeard = Date.now();

  const sendJson = (payload: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  const encoder = new ScreenEncoder(
    (packet) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(packet);
    },
    () => ({ quality: session.preferredQuality, maxScrollY: session.scrollInfo.max, dpr: session.dpr }),
  );

  const unsubscribe = session.subscribe((event: SessionEvent, data: unknown) => {
    if (event === "frame") encoder.push(data as Frame);
    else if (event === "closed") {
      sendJson({ t: "closed", d: data });
      const reason = (data as { reason?: string }).reason ?? "ended";
      setTimeout(() => ws.close(CLOSE_SESSION_ENDED, reason), 50);
    } else sendJson({ t: event, d: data });
  });

  sendJson({ t: "state", d: session.getState() });
  sendJson({ t: "scroll", d: { seq: 0, ...session.scrollInfo } });
  if (session.lastFrame) encoder.push(session.lastFrame);

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let msg: { t?: string; seq?: number; events?: unknown; ts?: number };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    session.lastSeen = Date.now();
    lastHeard = Date.now();
    switch (msg.t) {
      case "ack":
        if (typeof msg.seq === "number") encoder.ack(msg.seq);
        break;
      case "repaint":
        encoder.resetReference();
        if (session.lastFrame) encoder.push(session.lastFrame);
        break;
      case "input": {
        const events = sanitizeEvents(msg.events);
        if (!events.length) break;
        void session.input(events).then((result) => {
          if (result && "copied" in result && result.copied) sendJson({ t: "copied", d: { text: result.copied } });
        });
        break;
      }
      case "ping":
        sendJson({ t: "pong", d: { ts: msg.ts } });
        break;
    }
  });

  // Heartbeat: keeps proxies from closing the socket and measures RTT for rate control.
  // Protocol-level pongs are answered by the browser's network stack even when the tab is in
  // the background, so silence really means the viewer is gone.
  let pingSentAt = 0;
  ws.on("pong", () => {
    lastHeard = Date.now();
    if (pingSentAt) encoder.setRtt(Date.now() - pingSentAt);
  });
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastHeard > DEAD_AFTER_MS) {
      ws.terminate();
      return;
    }
    pingSentAt = Date.now();
    ws.ping();
    sendJson({ t: "stats", d: encoder.stats() });
  }, 1000);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    unsubscribe();
    encoder.close();
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

type EmitFn = (this: http.Server, event: string | symbol, ...args: unknown[]) => boolean;

/**
 * `next start` owns the HTTP server, so we intercept its "upgrade" events for
 * our path. Everything else (including Next's own upgrades) passes through.
 */
export function installWsGateway() {
  const g = globalThis as typeof globalThis & { __lumaWsGateway?: boolean };
  if (g.__lumaWsGateway) return;
  g.__lumaWsGateway = true;

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 << 20 });
  const proto = http.Server.prototype as unknown as { emit: EmitFn };
  const originalEmit = proto.emit;

  proto.emit = function (this: http.Server, event: string | symbol, ...args: unknown[]) {
    if (event === "upgrade") {
      const [req, socket, head] = args as [http.IncomingMessage, Duplex, Buffer];
      const pathname = (req.url ?? "").split("?")[0];
      if (pathname === PATH) {
        if (!sameOriginHost(req)) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          socket.destroy();
          return true;
        }
        wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, req));
        return true;
      }
    }
    return originalEmit.call(this, event, ...args);
  };
}
