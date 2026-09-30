import type { InputEvent } from "./remote-browser";

const BUTTONS = new Set(["left", "middle", "right"]);

function num(value: unknown, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function sanitize(raw: unknown): InputEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const x = num(e.x, 0, 4000);
  const y = num(e.y, 0, 4000);
  switch (e.type) {
    case "move":
      return x === null || y === null ? null : { type: "move", x, y };
    case "down":
    case "up": {
      if (x === null || y === null) return null;
      const button = BUTTONS.has(String(e.button)) ? (e.button as "left" | "middle" | "right") : "left";
      return { type: e.type, x, y, button, clicks: num(e.clicks, 1, 3) ?? 1 };
    }
    case "wheel": {
      const dx = num(e.dx, -5000, 5000) ?? 0;
      const dy = num(e.dy, -5000, 5000) ?? 0;
      const seq = num(e.seq, 0, 2 ** 31);
      return x === null || y === null ? null : { type: "wheel", x, y, dx, dy, ...(seq ? { seq: Math.floor(seq) } : {}) };
    }
    case "touch": {
      if (e.phase !== "start" && e.phase !== "move" && e.phase !== "end" && e.phase !== "cancel") return null;
      if (!Array.isArray(e.points) || e.points.length > 2 || ((e.phase === "start" || e.phase === "move") && e.points.length === 0)) return null;
      const points = e.points.flatMap((rawPoint, index) => {
        if (!rawPoint || typeof rawPoint !== "object") return [];
        const point = rawPoint as Record<string, unknown>;
        const px = num(point.x, 0, 4000);
        const py = num(point.y, 0, 4000);
        if (px === null || py === null) return [];
        return [{ id: Math.floor(num(point.id, 0, 32) ?? index), x: px, y: py }];
      });
      if (points.length !== e.points.length) return null;
      const seq = num(e.seq, 0, 2 ** 31);
      return { type: "touch", phase: e.phase, points, ...(seq ? { seq: Math.floor(seq) } : {}) };
    }
    case "press":
      return typeof e.key === "string" && e.key.length > 0 && e.key.length <= 40 ? { type: "press", key: e.key } : null;
    case "text":
      return typeof e.text === "string" && e.text.length > 0 ? { type: "text", text: e.text.slice(0, 10000) } : null;
    default:
      return null;
  }
}

export function sanitizeEvents(raw: unknown): InputEvent[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 200).map(sanitize).filter((e): e is InputEvent => e !== null);
}
