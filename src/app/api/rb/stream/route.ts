import { NextRequest } from "next/server";
import { getSession } from "@/lib/remote-browser";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Server-Sent Events: tab state, screen frames and toasts for one session. */
export function GET(request: NextRequest) {
  const session = getSession(request.nextUrl.searchParams.get("session"));
  if (!session) return new Response("session not found", { status: 404 });

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const send = (event: string, data: unknown) => {
        // Drop frames (never state) when the client can't keep up.
        if (event === "frame" && (controller.desiredSize ?? 1) < -3) return;
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      write(`retry: 1500\n\n`);
      send("state", session.getState());
      if (session.lastFrame) send("frame", session.lastFrame);
      const unsubscribe = session.subscribe((event, data) => {
        send(event, data);
        if (event === "closed") setTimeout(() => cleanup(), 50);
      });
      const heartbeat = setInterval(() => write(`: ping\n\n`), 15000);

      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
