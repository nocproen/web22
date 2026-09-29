import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/remote-browser";
import { sanitizeEvents } from "@/lib/remote-input";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** HTTP fallback for input when WebSocket is unavailable. */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { session?: string; events?: unknown } | null;
  const session = getSession(body?.session);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const events = sanitizeEvents(body?.events);
  const result = events.length ? await session.input(events) : {};
  return NextResponse.json(result);
}
