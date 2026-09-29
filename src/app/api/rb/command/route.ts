import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/remote-browser";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ACTIONS = new Set([
  "goto", "back", "forward", "reload", "stop", "newTab", "closeTab", "activate", "resize", "quality",
  "context", "translate", "untranslate", "translateText",
]);

const num = (value: unknown, min: number, max: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
};

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const session = getSession(typeof body?.session === "string" ? body.session : null);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const action = typeof body?.action === "string" ? body.action : "";
  if (!ACTIONS.has(action)) return NextResponse.json({ error: "unknown action" }, { status: 400 });

  const result = await session.command(action, {
    url: typeof body?.url === "string" ? body.url.slice(0, 8000) : undefined,
    tabId: typeof body?.tabId === "number" ? body.tabId : undefined,
    width: num(body?.width, 0, 10000),
    height: num(body?.height, 0, 10000),
    quality: typeof body?.quality === "string" ? body.quality : undefined,
    x: num(body?.x, 0, 4000),
    y: num(body?.y, 0, 4000),
    lang: typeof body?.lang === "string" ? body.lang : undefined,
    text: typeof body?.text === "string" ? body.text.slice(0, 5000) : undefined,
    force: body?.force === true,
  });
  return NextResponse.json(result);
}
