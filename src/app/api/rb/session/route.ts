import { NextRequest, NextResponse } from "next/server";
import { BusyError, capacityInfo, closeSession, createSession, engineStatus, ensureEngine, getSession } from "@/lib/remote-browser";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Reuse an existing session or create a new one. Returns 202 while the engine is still preparing. */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { id?: string; width?: number; height?: number; dpr?: number; reset?: boolean };

  if (body.reset && body.id) await closeSession(body.id);
  const existing = body.reset ? null : getSession(body.id);
  if (existing) return NextResponse.json({ id: existing.id, state: existing.getState() });

  const status = engineStatus();
  if (status.status !== "ready") {
    ensureEngine().catch(() => {});
    const current = engineStatus();
    if (current.status === "error") return NextResponse.json({ error: current.message || "浏览器引擎启动失败" }, { status: 500 });
    if (current.status !== "ready") return NextResponse.json({ preparing: true, message: current.message || "正在启动浏览器引擎…" }, { status: 202 });
  }

  try {
    const session = await createSession({ width: body.width, height: body.height }, body.dpr);
    return NextResponse.json({ id: session.id, state: session.getState() });
  } catch (error) {
    if (error instanceof BusyError) {
      return NextResponse.json(
        { busy: true, message: error.message, retryAfter: error.retryAfter, ...capacityInfo() },
        { status: 503, headers: { "retry-after": String(error.retryAfter) } },
      );
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建浏览器会话" }, { status: 500 });
  }
}

export function GET() {
  return NextResponse.json({ ...engineStatus(), ...capacityInfo() });
}
