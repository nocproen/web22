/**
 * Page translation backend (server-side, so page CSP / CORS never get in the way).
 *
 * Uses Google's batch "translateHtml" endpoint — the one Chrome's website
 * translator uses. Inputs are HTML-escaped plain strings; outputs are decoded.
 */

export const LANGUAGES = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  fr: "Français",
  de: "Deutsch",
  es: "Español",
  ru: "Русский",
} as const;

export type LangCode = keyof typeof LANGUAGES;

export function isLangCode(value: unknown): value is LangCode {
  return typeof value === "string" && value in LANGUAGES;
}

/** Human name for a detected source language code. */
const SOURCE_NAMES: Record<string, string> = {
  en: "英语", zh: "中文", "zh-CN": "中文", "zh-TW": "繁体中文", ja: "日语", ko: "韩语", fr: "法语", de: "德语",
  es: "西班牙语", ru: "俄语", pt: "葡萄牙语", it: "意大利语", ar: "阿拉伯语", hi: "印地语", vi: "越南语", th: "泰语",
  id: "印尼语", tr: "土耳其语", nl: "荷兰语", pl: "波兰语", uk: "乌克兰语", sv: "瑞典语",
};

export function sourceName(code: string | null | undefined) {
  if (!code) return null;
  return SOURCE_NAMES[code] ?? SOURCE_NAMES[code.split("-")[0]] ?? code;
}

const ENDPOINT = "https://translate-pa.googleapis.com/v1/translateHtml";
const API_KEY = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520"; // public key used by Chrome's translate element
const MAX_ITEMS = 100;
const MAX_CHARS = 4500;
const CONCURRENCY = 4;
const CACHE_LIMIT = 60_000;

type Result = { text: string; source: string | null };

const g = globalThis as typeof globalThis & { __lumaTrCache?: Map<string, Result> };
const cache: Map<string, Result> = (g.__lumaTrCache ??= new Map());

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function decodeHtml(text: string) {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function requestBatch(texts: string[], lang: LangCode, attempt = 0): Promise<Result[]> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json+protobuf", "x-goog-api-key": API_KEY },
      body: JSON.stringify([[texts.map(escapeHtml), "auto", lang], "te_lib"]),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`translate HTTP ${res.status}`);
    const data = (await res.json()) as [string[], string[]?];
    const out = data?.[0];
    if (!Array.isArray(out) || out.length !== texts.length) throw new Error("unexpected translate response");
    const sources = Array.isArray(data[1]) ? data[1] : [];
    return out.map((text, i) => ({ text: decodeHtml(String(text ?? texts[i])), source: sources[i] ?? null }));
  } catch (error) {
    if (attempt < 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return requestBatch(texts, lang, attempt + 1);
    }
    throw error;
  }
}

function remember(key: string, value: Result) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
}

/**
 * Translates `texts` into `lang`. `onBatch` receives results progressively
 * (index → translation) so the page can update while the rest is in flight.
 */
export async function translateTexts(
  texts: string[],
  lang: LangCode,
  onBatch?: (results: { index: number; text: string; source: string | null }[]) => Promise<void> | void,
) {
  const results: (Result | null)[] = texts.map(() => null);
  const cached: { index: number; text: string; source: string | null }[] = [];
  const pending: number[] = [];

  texts.forEach((text, index) => {
    const hit = cache.get(`${lang}\u0000${text}`);
    if (hit) {
      results[index] = hit;
      cached.push({ index, ...hit });
    } else {
      pending.push(index);
    }
  });
  if (cached.length && onBatch) await onBatch(cached);

  // Group uncached strings into requests; identical strings are sent once.
  const unique = new Map<string, number[]>();
  for (const index of pending) {
    const list = unique.get(texts[index]);
    if (list) list.push(index);
    else unique.set(texts[index], [index]);
  }
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const text of unique.keys()) {
    if (current.length && (current.length >= MAX_ITEMS || chars + text.length > MAX_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += text.length;
  }
  if (current.length) batches.push(current);

  let failures = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      try {
        const translated = await requestBatch(batch, lang);
        const update: { index: number; text: string; source: string | null }[] = [];
        batch.forEach((text, i) => {
          const value = translated[i];
          remember(`${lang}\u0000${text}`, value);
          for (const index of unique.get(text) ?? []) {
            results[index] = value;
            update.push({ index, ...value });
          }
        });
        if (onBatch) await onBatch(update);
      } catch {
        failures += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));

  if (failures && failures === batches.length && batches.length > 0) throw new Error("翻译服务暂时不可用");
  return results;
}

/** Most common detected source language among results (by character count). */
export function dominantSource(texts: string[], results: (Result | null)[]) {
  const weight = new Map<string, number>();
  results.forEach((r, i) => {
    if (!r?.source) return;
    weight.set(r.source, (weight.get(r.source) ?? 0) + texts[i].length);
  });
  let best: string | null = null;
  let max = 0;
  for (const [code, w] of weight) if (w > max) [best, max] = [code, w];
  return best;
}
