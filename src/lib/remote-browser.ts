import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { PAGE_RUNTIME } from "./page-runtime";
import { dominantSource, isLangCode, type LangCode, sourceName, translateTexts } from "./translator";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type Viewport = { width: number; height: number };

export type CommandPayload = {
  url?: string;
  tabId?: number;
  width?: number;
  height?: number;
  quality?: string;
  x?: number;
  y?: number;
  lang?: string;
  text?: string;
  force?: boolean;
};

export type TranslateStatus = "translating" | "done" | "same" | "error";

export type TabState = {
  id: number;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  translate: { lang: LangCode; status: TranslateStatus; source: string | null } | null;
};

export type ContextInfo = { link: string; linkText: string; image: string; selection: string; editable: boolean };

type TranslateJob = {
  lang: LangCode;
  status: TranslateStatus;
  source: string | null;
  force: boolean;
  running: boolean;
  again: boolean;
  timer: NodeJS.Timeout | null;
};

/** Browser-side shape of the injected runtime (see page-runtime.ts). */
type LumaWindow = Window & {
  __lumaTr?: {
    start(lang: string): void;
    collect(maxItems: number, maxChars: number): [number, string][];
    apply(pairs: [number, string][]): number;
    restore(): void;
    pageLang(): string;
    isActive(): boolean;
  };
  __lumaCtxInfo?: (x: number, y: number) => (ContextInfo & { prevented: boolean }) | null;
};

const PASS_ITEMS = 400;
const PASS_CHARS = 20_000;

/** <html lang> values that already count as the target language. */
function sameLanguageCodes(lang: LangCode) {
  if (lang === "zh-CN") return ["zh", "zh-cn", "zh-hans", "zh-sg", "zh-hans-cn"];
  if (lang === "zh-TW") return ["zh-tw", "zh-hant", "zh-hk", "zh-mo", "zh-hant-tw"];
  return [lang, `${lang}-us`, `${lang}-gb`, `${lang}-${lang}`].map((c) => c.toLowerCase());
}

function sameAsTarget(source: string | null, lang: LangCode) {
  if (!source) return false;
  const s = source.toLowerCase();
  if (lang === "zh-CN") return s === "zh-cn" || s === "zh";
  if (lang === "zh-TW") return s === "zh-tw";
  return s.split("-")[0] === lang;
}

const isNavError = (error: unknown) => /Execution context was destroyed|Target (page|closed)|frame was detached|navigat/i.test(String(error));

function withTimeout<T>(promise: Promise<T>, ms: number) {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

export type SessionState = {
  tabs: TabState[];
  activeId: number | null;
  viewport: Viewport;
};

/** A source frame from Chromium (device pixels). scrollY is the root scroll offset in CSS px. */
export type Frame = { tab: number; seq: number; w: number; h: number; data: string; scrollY: number | null; ts: number; inputSeq: number };

export type InputEvent =
  | { type: "move"; x: number; y: number }
  | { type: "down" | "up"; x: number; y: number; button: "left" | "middle" | "right"; clicks: number }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number; seq?: number }
  | { type: "press"; key: string }
  | { type: "text"; text: string };

export type EngineStatus = { status: "idle" | "installing" | "launching" | "ready" | "error"; message: string };

export type SessionEvent = "state" | "frame" | "toast" | "cursor" | "scroll" | "closed";
type Listener = (event: SessionEvent, data: unknown) => void;

export type Quality = "auto" | "smooth" | "balanced" | "sharp";
const MASK = { left: 1, right: 2, middle: 4 } as const;

type Tab = {
  id: number;
  page: Page;
  cdp: CDPSession;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  translate: TranslateJob | null;
};

/* ------------------------------------------------------------------ */
/* Limits & security                                                   */
/* ------------------------------------------------------------------ */

/** Hard cap; the real limit is whatever fits in memory (see hasRoomForSession). */
const MAX_SESSIONS = Math.max(1, Number(process.env.LUMA_MAX_SESSIONS) || 16);
/** Approximate memory one session needs (Chromium renderer + compositor at up to 2x). */
const SESSION_MEMORY = 320 * 1024 * 1024;
/** Always keep this much memory free for the server itself. */
const RESERVED_MEMORY = 450 * 1024 * 1024;
/** A connected session with no input for this long may be reclaimed when the server is full. */
const RECLAIM_AFTER_MS = (Number(process.env.LUMA_RECLAIM_SECONDS) || 90) * 1000;
/** A connected session with no input for this long is closed regardless (tab left open). */
const ABANDONED_MS = 30 * 60 * 1000;
const MAX_TABS = 10;
const IDLE_MS = 10 * 60 * 1000;

// Block the remote browser from reaching the server itself or private networks.
const PRIVATE_HOSTS = [
  "localhost*", "127.*", "10.*", "192.168.*", "169.254.*", "0.*", "[::1]*", "[fc*", "[fd*", "[fe80*",
  "metadata.google.internal*", ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`),
];
const BLOCK_PATTERNS = ["http", "https", "ws", "wss"].flatMap((scheme) => PRIVATE_HOSTS.map((host) => ({ urlPattern: `${scheme}://${host}` })));

export function isAllowedUrl(raw: string) {
  if (raw === "about:blank") return true;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host || host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "metadata.google.internal") return false;
    if (/^(127|10|0)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
    const m = host.match(/^172\.(\d{1,3})\./);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false;
    if (host.includes(":") && /^(fc|fd|fe80)/i.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Global store (shared across route bundles in the same process)      */
/* ------------------------------------------------------------------ */

type Store = {
  browsers: Map<number, Browser>;
  starting: Map<number, Promise<Browser>>;
  installed: boolean;
  engine: EngineStatus;
  sessions: Map<string, RemoteSession>;
  sweeper: NodeJS.Timeout | null;
};

const g = globalThis as typeof globalThis & { __lumaRemote?: Store };
const store: Store = (g.__lumaRemote ??= {
  browsers: new Map(),
  starting: new Map(),
  installed: false,
  engine: { status: "idle", message: "" },
  sessions: new Map(),
  sweeper: null,
});

/* ------------------------------------------------------------------ */
/* Engine bootstrap                                                    */
/* ------------------------------------------------------------------ */

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=Translate,MediaRouter",
  "--autoplay-policy=no-user-gesture-required",
];

function run(command: string, args: string[], timeoutMs: number) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** Screen captures only come out at device resolution when the scale factor is forced on the browser process. */
export function dprBucket(dpr: unknown) {
  const value = Number(dpr) || 1;
  if (value <= 1.1) return 1;
  if (value <= 1.6) return 1.5;
  return 2;
}

async function launchOnce(bucket: number): Promise<Browser> {
  const { chromium } = await import("playwright");
  const args = [...LAUNCH_ARGS, `--force-device-scale-factor=${bucket}`];
  try {
    return await chromium.launch({ channel: "chromium", args });
  } catch (first) {
    try {
      return await chromium.launch({ args });
    } catch {
      throw first;
    }
  }
}

async function startEngine(bucket: number): Promise<Browser> {
  if (!store.installed) store.engine = { status: "launching", message: "正在启动浏览器引擎…" };
  let browser: Browser;
  try {
    browser = await launchOnce(bucket);
  } catch (error) {
    const text = String(error);
    if (/Executable doesn't exist|playwright install|browserType\.launch: Executable/i.test(text)) {
      store.engine = { status: "installing", message: "首次运行，正在下载 Chromium 浏览器引擎（约 1 分钟）…" };
      const res = await run("npx", ["--yes", "playwright", "install", "chromium"], 5 * 60 * 1000);
      if (res.code !== 0) throw new Error(`Chromium 下载失败：${res.output.slice(-300)}`);
    }
    try {
      store.engine = { status: "launching", message: "正在启动浏览器引擎…" };
      browser = await launchOnce(bucket);
    } catch (second) {
      const msg = String(second);
      if (!/missing dependencies|shared libraries|Host system is missing/i.test(msg)) throw second;
      store.engine = { status: "installing", message: "正在安装浏览器运行所需的系统组件…" };
      const res = await run("sudo", ["-n", "env", `PATH=${process.env.PATH ?? ""}`, "npx", "--yes", "playwright", "install-deps", "chromium"], 6 * 60 * 1000);
      if (res.code !== 0) throw new Error(`系统组件安装失败：${res.output.slice(-300)}`);
      store.engine = { status: "launching", message: "正在启动浏览器引擎…" };
      browser = await launchOnce(bucket);
    }
  }

  browser.on("disconnected", () => {
    store.browsers.delete(bucket);
    store.starting.delete(bucket);
    for (const [id, session] of store.sessions) {
      if (session.bucket !== bucket) continue;
      session.markDead();
      store.sessions.delete(id);
    }
  });
  store.browsers.set(bucket, browser);
  store.installed = true;
  store.engine = { status: "ready", message: "" };
  return browser;
}

/** Starts (or returns) the shared Chromium instance. Never throws. */
export function ensureEngine(bucket = 1) {
  const existing = store.browsers.get(bucket);
  if (existing?.isConnected()) return Promise.resolve(existing);
  let starting = store.starting.get(bucket);
  if (!starting) {
    starting = startEngine(bucket).catch((error) => {
      store.starting.delete(bucket);
      store.engine = { status: "error", message: String(error instanceof Error ? error.message : error).slice(0, 400) };
      throw error;
    });
    starting.catch(() => {});
    store.starting.set(bucket, starting);
  }
  return starting;
}

export function engineStatus(): EngineStatus {
  if (store.installed && store.engine.status !== "installing") return { status: "ready", message: "" };
  return store.engine;
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

function clampViewport(v: Partial<Viewport> | undefined): Viewport {
  const width = Math.round(Math.min(2560, Math.max(320, Number(v?.width) || 1280)));
  const height = Math.round(Math.min(1600, Math.max(240, Number(v?.height) || 800)));
  return { width, height };
}

export class RemoteSession {
  readonly id = randomUUID();
  lastSeen = Date.now();
  lastFrame: Frame | null = null;
  private tabs = new Map<number, Tab>();
  private order: number[] = [];
  private attaching = new Map<Page, Promise<Tab | null>>();
  private activeId: number | null = null;
  private screencastTab: number | null = null;
  private nextTabId = 1;
  private seq = 0;
  private listeners = new Set<Listener>();
  private queue: Promise<unknown> = Promise.resolve();
  private stateTimer: NodeJS.Timeout | null = null;
  private lastCursorAt = 0;
  private probing = false;
  private cursor = "default";
  private pressed: "left" | "middle" | "right" | null = null;
  private quality: Quality = "auto";
  private dead = false;

  private wheelLog: { seq: number; at: number }[] = [];
  private wheelSeq = 0;
  private scrollProbing = false;
  private scrollProbeAgain = false;
  scrollInfo: { y: number; max: number } = { y: 0, max: -1 };

  private constructor(private context: BrowserContext, public viewport: Viewport, readonly bucket: number) {}

  get dpr() {
    return this.bucket;
  }

  get preferredQuality() {
    return this.quality;
  }

  /** Highest wheel sequence whose effect is visible in a frame swapped at `ts` (ms since epoch). */
  wheelSeqBefore(ts: number) {
    let seq = 0;
    for (const entry of this.wheelLog) if (entry.at + 8 <= ts) seq = entry.seq;
    return seq;
  }

  static async create(browser: Browser, viewport: Viewport, bucket: number) {
    const version = browser.version().split(".")[0] || "150";
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: bucket,
      locale: "zh-CN",
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`,
      acceptDownloads: false,
      serviceWorkers: "allow",
    });
    const session = new RemoteSession(context, viewport, bucket);
    await context.addInitScript({ content: PAGE_RUNTIME });
    await context.exposeBinding("__lumaNotify", (source) => session.onPageNotify(source.page));
    context.on("page", (page) => {
      void session.attach(page, true);
    });
    context.on("close", () => session.markDead());
    await session.newTab();
    return session;
  }

  get alive() {
    return !this.dead;
  }

  get listenerCount() {
    return this.listeners.size;
  }

  /** Last real user activity (input or command), as opposed to background traffic. */
  lastActive = Date.now();

  markDead() {
    if (this.dead) return;
    this.dead = true;
    this.emit("closed", { reason: "crashed", message: "浏览器会话意外结束" });
    this.listeners.clear();
  }

  /** Closes the session and tells every viewer why, so they can show a clear message instead of retrying blindly. */
  async close(reason: "idle" | "reclaimed" | "reset" = "reset", message = "") {
    if (!this.dead) {
      this.dead = true;
      this.emit("closed", { reason, message });
    }
    this.listeners.clear();
    await this.context.close().catch(() => {});
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    this.lastSeen = Date.now();
    return () => {
      this.listeners.delete(listener);
      this.lastSeen = Date.now();
    };
  }

  private emit(event: SessionEvent, data: unknown) {
    for (const listener of this.listeners) {
      try {
        listener(event, data);
      } catch {
        /* ignore broken listener */
      }
    }
  }

  private scheduleState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.emit("state", this.getState());
    }, 40);
  }

  toast(message: string) {
    this.emit("toast", { message });
  }

  getState(): SessionState & { quality: Quality; dpr: number } {
    return {
      activeId: this.activeId,
      viewport: this.viewport,
      quality: this.quality,
      dpr: this.bucket,
      tabs: this.order
        .map((id) => this.tabs.get(id))
        .filter((tab): tab is Tab => Boolean(tab))
        .map(({ id, title, url, loading, canGoBack, canGoForward, translate }) => ({
          id, title, url, loading, canGoBack, canGoForward,
          translate: translate ? { lang: translate.lang, status: translate.status, source: sourceName(translate.source) } : null,
        })),
    };
  }

  /** Serialise all page operations so input stays in order. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  private active() {
    return this.activeId === null ? null : this.tabs.get(this.activeId) ?? null;
  }

  /* ---------------- tabs ---------------- */

  private attach(page: Page, activate: boolean): Promise<Tab | null> {
    const existing = [...this.tabs.values()].find((tab) => tab.page === page);
    if (existing) return Promise.resolve(existing);
    const pending = this.attaching.get(page);
    if (pending) return pending;
    const promise = this.doAttach(page, activate).finally(() => this.attaching.delete(page));
    this.attaching.set(page, promise);
    return promise;
  }

  private async doAttach(page: Page, activate: boolean): Promise<Tab | null> {
    if (this.dead) return null;
    if (this.tabs.size >= MAX_TABS) {
      this.toast(`最多同时打开 ${MAX_TABS} 个标签页`);
      await page.close().catch(() => {});
      return null;
    }
    const cdp = await this.context.newCDPSession(page);
    const tab: Tab = { id: this.nextTabId++, page, cdp, title: "新标签页", url: page.url() || "about:blank", loading: false, canGoBack: false, canGoForward: false, translate: null };

    // Network guard: fail any request to private / local addresses.
    cdp.on("Fetch.requestPaused", (event: { requestId: string }) => {
      cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => {});
    });
    await cdp.send("Fetch.enable", { patterns: BLOCK_PATTERNS }).catch(() => {});

    cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number; metadata?: { scrollOffsetY?: number; timestamp?: number } }) => {
      cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      if (this.activeId !== tab.id) return;
      const meta = frame.metadata;
      this.pushFrame(tab.id, frame.data, typeof meta?.scrollOffsetY === "number" ? meta.scrollOffsetY : null, meta?.timestamp ? meta.timestamp * 1000 : Date.now() - 16);
    });

    const refreshTitle = () => {
      page.title().then((title) => {
        if (title && title !== tab.title) {
          tab.title = title;
          this.scheduleState();
        }
      }).catch(() => {});
    };

    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      // A kept translation carries over to the next page, like Chrome's "always translate".
      if (tab.translate && frame.url() !== tab.url) {
        tab.translate.status = "translating";
        tab.translate.source = null;
      }
      tab.url = frame.url();
      if (tab.url === "about:blank") tab.title = "新标签页";
      void this.refreshHistory(tab);
      setTimeout(refreshTitle, 300);
      this.scheduleState();
    });
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !tab.loading) {
        tab.loading = true;
        this.scheduleState();
      }
    });
    page.on("requestfailed", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        tab.loading = false;
        this.scheduleState();
      }
    });
    page.on("domcontentloaded", () => {
      refreshTitle();
      if (tab.translate) this.schedulePass(tab, 150);
    });
    page.on("load", () => {
      tab.loading = false;
      refreshTitle();
      this.scheduleState();
      if (this.activeId === tab.id) this.probeScroll(tab);
      if (tab.translate) this.schedulePass(tab, 250);
    });
    page.on("dialog", (dialog) => {
      const message = dialog.message();
      if (message && dialog.type() !== "beforeunload") this.toast(`网页提示：${message.slice(0, 160)}`);
      (dialog.type() === "prompt" ? dialog.accept(dialog.defaultValue()) : dialog.accept()).catch(() => {});
    });
    page.on("close", () => {
      void this.removeTab(tab.id);
    });

    this.tabs.set(tab.id, tab);
    this.order.push(tab.id);
    if (activate || this.activeId === null) await this.activate(tab.id);
    else this.scheduleState();
    return tab;
  }

  async newTab(url?: string) {
    const page = await this.context.newPage();
    const tab = await this.attach(page, true);
    if (tab && url && url !== "about:blank") this.navigate(tab, url);
    return tab;
  }

  private async removeTab(id: number) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const index = this.order.indexOf(id);
    this.tabs.delete(id);
    this.order = this.order.filter((tabId) => tabId !== id);
    tab.cdp.detach().catch(() => {});
    if (this.screencastTab === id) this.screencastTab = null;
    if (this.dead) return;
    if (this.activeId === id) {
      this.activeId = null;
      const nextId = this.order[Math.max(0, index - 1)];
      if (nextId !== undefined) await this.activate(nextId);
      else await this.newTab();
    }
    this.scheduleState();
  }

  async activate(id: number) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (this.screencastTab !== null && this.screencastTab !== id) {
      await this.tabs.get(this.screencastTab)?.cdp.send("Page.stopScreencast").catch(() => {});
    }
    this.activeId = id;
    this.scheduleState();
    await tab.page.setViewportSize(this.viewport).catch(() => {});
    await tab.page.bringToFront().catch(() => {});
    await this.startScreencast(tab);
  }

  private async startScreencast(tab: Tab) {
    await tab.cdp.send("Page.stopScreencast").catch(() => {});
    // Source frames: device pixels, high quality. Each client connection re-encodes only what changed.
    const w = Math.round(this.viewport.width * this.bucket);
    const h = Math.round(this.viewport.height * this.bucket);
    await tab.cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: w, maxHeight: h, everyNthFrame: 1 }).catch(() => {});
    this.screencastTab = tab.id;
    // Static pages may not produce a new compositor frame; send one immediately.
    const shot = await tab.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85, optimizeForSpeed: true }).catch(() => null);
    if (shot && this.activeId === tab.id) this.pushFrame(tab.id, shot.data, null, Date.now());
    this.probeScroll(tab);
  }

  private pushFrame(tabId: number, data: string, scrollY: number | null, ts: number) {
    const frame: Frame = {
      tab: tabId,
      seq: ++this.seq,
      w: Math.round(this.viewport.width * this.bucket),
      h: Math.round(this.viewport.height * this.bucket),
      data,
      scrollY,
      ts,
      inputSeq: this.wheelSeqBefore(ts),
    };
    this.lastFrame = frame;
    this.emit("frame", frame);
  }

  private async refreshHistory(tab: Tab) {
    const history = await tab.cdp.send("Page.getNavigationHistory").catch(() => null);
    if (!history) return;
    tab.canGoBack = history.currentIndex > 0;
    tab.canGoForward = history.currentIndex < history.entries.length - 1;
    this.scheduleState();
  }

  private navigate(tab: Tab, url: string) {
    tab.loading = true;
    this.scheduleState();
    tab.page.goto(url, { waitUntil: "commit", timeout: 45000 }).catch((error: unknown) => {
      tab.loading = false;
      this.scheduleState();
      const text = String(error);
      if (/ERR_ABORTED|frame was detached|Target (page|closed)|interrupted by another navigation/i.test(text)) return;
      const code = text.match(/net::(ERR_[A-Z_]+)/)?.[1];
      this.toast(code ? `无法打开页面（${code}）` : "页面加载超时或失败");
    });
  }

  /* ---------------- commands ---------------- */

  command(action: string, payload: CommandPayload): Promise<Record<string, unknown>> {
    this.lastSeen = Date.now();
    if (action !== "resize" && action !== "quality") this.lastActive = Date.now();
    // Network-bound work must never sit in the input queue.
    if (action === "translateText") return this.translateSnippet(payload);
    return this.enqueue(async (): Promise<Record<string, unknown>> => {
      const tab = payload.tabId !== undefined ? this.tabs.get(payload.tabId) ?? null : this.active();
      switch (action) {
        case "goto": {
          const url = String(payload.url ?? "");
          if (!isAllowedUrl(url)) {
            this.toast("出于安全原因，不能访问本地或内网地址");
            return { ok: false };
          }
          if (tab) this.navigate(tab, url);
          return { ok: true };
        }
        case "back":
          if (tab) tab.page.goBack({ waitUntil: "commit", timeout: 20000 }).catch(() => {});
          return { ok: true };
        case "forward":
          if (tab) tab.page.goForward({ waitUntil: "commit", timeout: 20000 }).catch(() => {});
          return { ok: true };
        case "reload":
          if (tab) tab.page.reload({ waitUntil: "commit", timeout: 45000 }).catch(() => {});
          return { ok: true };
        case "stop":
          if (tab) await tab.cdp.send("Page.stopLoading").catch(() => {});
          return { ok: true };
        case "newTab": {
          const url = payload.url && isAllowedUrl(payload.url) ? payload.url : undefined;
          await this.newTab(url);
          return { ok: true };
        }
        case "closeTab":
          if (tab) {
            if (this.tabs.size === 1) {
              this.navigate(tab, "about:blank");
            } else {
              await tab.page.close().catch(() => {});
            }
          }
          return { ok: true };
        case "activate":
          if (tab) await this.activate(tab.id);
          return { ok: true };
        case "resize": {
          const next = clampViewport(payload);
          if (next.width === this.viewport.width && next.height === this.viewport.height) return { ok: true };
          this.viewport = next;
          await Promise.all([...this.tabs.values()].map((t) => t.page.setViewportSize(next).catch(() => {})));
          const current = this.active();
          if (current) await this.startScreencast(current);
          this.scheduleState();
          return { ok: true };
        }
        case "context": {
          if (!tab) return { ok: false };
          return { ok: true, info: await this.contextAt(tab, Number(payload.x) || 0, Number(payload.y) || 0) };
        }
        case "translate": {
          if (!tab) return { ok: false };
          const lang: LangCode = isLangCode(payload.lang) ? payload.lang : "zh-CN";
          if (tab.translate?.timer) clearTimeout(tab.translate.timer);
          tab.translate = { lang, status: "translating", source: null, force: Boolean(payload.force), running: false, again: false, timer: null };
          this.scheduleState();
          this.schedulePass(tab, 0);
          return { ok: true };
        }
        case "untranslate": {
          if (!tab) return { ok: false };
          if (tab.translate?.timer) clearTimeout(tab.translate.timer);
          tab.translate = null;
          await withTimeout(tab.page.evaluate(() => (window as LumaWindow).__lumaTr?.restore()).catch(() => {}), 2000);
          tab.title = (await tab.page.title().catch(() => tab.title)) || tab.title;
          this.scheduleState();
          return { ok: true };
        }
        case "quality": {
          const next = payload.quality as Quality;
          if (!["auto", "smooth", "balanced", "sharp"].includes(next) || next === this.quality) return { ok: true };
          this.quality = next;
          this.scheduleState();
          return { ok: true };
        }
        default:
          return { ok: false };
      }
    });
  }

  /* ---------------- input ---------------- */

  /** Mouse events go straight to CDP: one round trip each, no Playwright bookkeeping. */
  private dispatchMouse(tab: Tab, type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number, clickCount = 0) {
    const button = this.pressed ?? "none";
    const buttons = type === "mouseReleased" || !this.pressed ? 0 : MASK[this.pressed];
    return tab.cdp.send("Input.dispatchMouseEvent", { type, x, y, button, buttons, clickCount });
  }

  input(events: InputEvent[]) {
    this.lastSeen = Date.now();
    this.lastActive = Date.now();
    return this.enqueue(async () => {
      const tab = this.active();
      if (!tab) return {};
      let lastPoint: { x: number; y: number } | null = null;
      let copied: string | undefined;
      let wheeled = false;

      for (const event of events) {
        try {
          switch (event.type) {
            case "move":
              await this.dispatchMouse(tab, "mouseMoved", event.x, event.y);
              lastPoint = event;
              break;
            case "down":
              this.pressed = event.button;
              await this.dispatchMouse(tab, "mousePressed", event.x, event.y, event.clicks);
              break;
            case "up":
              if (!this.pressed) this.pressed = event.button;
              await this.dispatchMouse(tab, "mouseReleased", event.x, event.y, event.clicks);
              this.pressed = null;
              break;
            case "wheel":
              await tab.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: event.x, y: event.y, deltaX: event.dx, deltaY: event.dy });
              if (event.seq) {
                this.wheelSeq = event.seq;
                this.wheelLog.push({ seq: event.seq, at: Date.now() });
                if (this.wheelLog.length > 64) this.wheelLog.shift();
                wheeled = true;
              }
              break;
            case "press":
              await tab.page.keyboard.press(event.key);
              if (/^Control\+[cx]$/i.test(event.key)) copied = await this.readSelection(tab);
              break;
            case "text":
              await tab.cdp.send("Input.insertText", { text: event.text });
              break;
          }
        } catch {
          /* ignore a single bad event (e.g. unknown key) */
        }
      }

      if (lastPoint) this.probeCursor(tab, lastPoint);
      if (wheeled) this.probeScroll(tab);
      return { copied };
    });
  }

  /* ---------------- context menu ---------------- */

  /** Delivers a real right-click to the page, then reports what's under the pointer. */
  private async contextAt(tab: Tab, x: number, y: number) {
    try {
      await this.dispatchMouse(tab, "mouseMoved", x, y);
      this.pressed = "right";
      await this.dispatchMouse(tab, "mousePressed", x, y, 1);
      await this.dispatchMouse(tab, "mouseReleased", x, y, 1);
    } catch {
      /* page busy or navigating */
    } finally {
      this.pressed = null;
    }
    const raw = await withTimeout(tab.page.evaluate(({ x, y }) => (window as LumaWindow).__lumaCtxInfo?.(x, y) ?? null, { x, y }).catch(() => null), 1500);
    const str = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
    if (!raw) return { prevented: false, link: "", linkText: "", image: "", selection: "", editable: false };
    return {
      prevented: Boolean(raw.prevented),
      link: /^https?:/i.test(str(raw.link, 4000)) ? str(raw.link, 4000) : "",
      linkText: str(raw.linkText, 200),
      image: /^https?:/i.test(str(raw.image, 4000)) ? str(raw.image, 4000) : "",
      selection: str(raw.selection, 5000),
      editable: Boolean(raw.editable),
    };
  }

  /* ---------------- translation ---------------- */

  onPageNotify(page: Page) {
    const tab = [...this.tabs.values()].find((t) => t.page === page);
    if (tab?.translate) this.schedulePass(tab, 0);
  }

  private schedulePass(tab: Tab, delay: number) {
    const job = tab.translate;
    if (!job) return;
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      job.timer = null;
      void this.runPass(tab, job);
    }, delay);
  }

  /** One translation pass: the untranslated text nearest the viewport, applied as batches arrive. */
  private async runPass(tab: Tab, job: TranslateJob) {
    if (tab.translate !== job || this.dead) return;
    if (job.running) {
      job.again = true;
      return;
    }
    job.running = true;
    try {
      const skip = job.force ? [] : sameLanguageCodes(job.lang);
      const result = await withTimeout(
        tab.page.evaluate(({ lang, skip, max, chars }) => {
          const tr = (window as LumaWindow).__lumaTr;
          if (!tr) return null;
          if (!tr.isActive() && skip.includes(tr.pageLang())) return { same: true, items: [] as [number, string][] };
          tr.start(lang);
          return { same: false, items: tr.collect(max, chars) };
        }, { lang: job.lang, skip, max: PASS_ITEMS, chars: PASS_CHARS }),
        4000,
      );
      if (!result || tab.translate !== job) return;
      if (result.same) {
        job.status = "same";
        return;
      }
      const items = (Array.isArray(result.items) ? result.items : [])
        .filter((item): item is [number, string] => Array.isArray(item) && Number.isInteger(item[0]) && typeof item[1] === "string")
        .slice(0, PASS_ITEMS)
        .map(([id, text]) => [id, text.slice(0, 5000)] as [number, string]);
      if (!items.length) {
        if (job.status === "translating") job.status = "done";
        return;
      }

      const texts = items.map(([, text]) => text);
      const translations = await translateTexts(texts, job.lang, async (batch) => {
        if (tab.translate !== job) return;
        const pairs = batch.map(({ index, text }) => [items[index][0], text] as [number, string]);
        await tab.page.evaluate((p) => (window as LumaWindow).__lumaTr?.apply(p), pairs).catch(() => {});
      });
      if (tab.translate !== job) return;

      if (!job.source) {
        job.source = dominantSource(texts, translations);
        if (!job.force && sameAsTarget(job.source, job.lang)) job.status = "same";
      }
      const title = await tab.page.title().catch(() => "");
      if (title) tab.title = title;
      if (items.length >= PASS_ITEMS || texts.join("").length >= PASS_CHARS * 0.9) job.again = true;
      else if (job.status === "translating") job.status = "done";
    } catch (error) {
      if (tab.translate === job && !isNavError(error)) {
        job.status = "error";
        this.toast("翻译服务暂时不可用，请稍后重试");
      }
    } finally {
      job.running = false;
      this.scheduleState();
      if (tab.translate === job && job.again) {
        job.again = false;
        this.schedulePass(tab, 30);
      }
    }
  }

  /** Translates a selected snippet for the popover (does not touch the page). */
  private async translateSnippet(payload: CommandPayload) {
    const text = typeof payload.text === "string" ? payload.text.trim().slice(0, 5000) : "";
    if (!text) return { ok: false };
    const lang: LangCode = isLangCode(payload.lang) ? payload.lang : "zh-CN";
    try {
      const [result] = await translateTexts([text], lang);
      return { ok: true, text: result?.text ?? text, source: sourceName(result?.source) };
    } catch {
      return { ok: false, error: "翻译服务暂时不可用" };
    }
  }

  /**
   * Reports the root scroll position/limit so the client can predict scrolling
   * locally (and knows when a wheel did nothing, e.g. at the bottom of a page).
   */
  private probeScroll(tab: Tab) {
    if (this.scrollProbing) {
      this.scrollProbeAgain = true;
      return;
    }
    this.scrollProbing = true;
    const seq = this.wheelSeq;
    const lookup = tab.page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return { y: window.scrollY, max: Math.max(0, (el?.scrollHeight ?? 0) - window.innerHeight) };
    });
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000));
    Promise.race([lookup, timeout])
      .then((info) => {
        if (!info || this.activeId !== tab.id) return;
        this.scrollInfo = info;
        this.emit("scroll", { seq, y: info.y, max: info.max });
      })
      .catch(() => {})
      .finally(() => {
        this.scrollProbing = false;
        if (this.scrollProbeAgain) {
          this.scrollProbeAgain = false;
          setTimeout(() => this.probeScroll(tab), 60);
        }
      });
  }

  /** Cursor shape lookup runs outside the input queue so a busy page never delays clicks or typing. */
  private probeCursor(tab: Tab, point: { x: number; y: number }) {
    if (this.probing || Date.now() - this.lastCursorAt < 150) return;
    this.probing = true;
    this.lastCursorAt = Date.now();
    const lookup = tab.page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return "default";
      const value = getComputedStyle(el).cursor;
      if (value && value !== "auto") return value;
      if (el.closest("a[href],button,[role=button],label,summary,select")) return "pointer";
      if (el.closest("input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable=''],[contenteditable=true]")) return "text";
      return "default";
    }, point);
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000));
    Promise.race([lookup, timeout])
      .then((cursor) => {
        if (cursor && cursor !== this.cursor) {
          this.cursor = cursor;
          this.emit("cursor", { cursor });
        }
      })
      .catch(() => {})
      .finally(() => {
        this.probing = false;
      });
  }

  private readSelection(tab: Tab) {
    return tab.page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (el && typeof el.selectionStart === "number" && typeof el.value === "string" && el.selectionEnd !== null) {
        return el.value.slice(el.selectionStart, el.selectionEnd);
      }
      return window.getSelection()?.toString() ?? "";
    }).catch(() => "");
  }
}

/* ------------------------------------------------------------------ */
/* Session registry                                                    */
/* ------------------------------------------------------------------ */

/** Memory the OS can hand out right now (MemAvailable counts reclaimable cache, unlike os.freemem()). */
function availableMemory() {
  try {
    const match = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (match) return Number(match[1]) * 1024;
  } catch {
    /* not Linux */
  }
  return os.freemem();
}

function hasRoomForSession() {
  if (store.sessions.size >= MAX_SESSIONS) return false;
  return availableMemory() - SESSION_MEMORY > RESERVED_MEMORY;
}

/** Rough number of additional sessions the machine can hold right now (for the UI). */
export function capacityInfo() {
  const spare = Math.max(0, Math.floor((availableMemory() - RESERVED_MEMORY) / SESSION_MEMORY));
  const active = store.sessions.size;
  return { active, limit: Math.min(MAX_SESSIONS, active + spare) };
}

function startSweeper() {
  if (store.sweeper) return;
  store.sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of store.sessions) {
      const orphaned = session.listenerCount === 0 && now - session.lastSeen > IDLE_MS;
      const abandoned = now - session.lastActive > ABANDONED_MS;
      if (!session.alive || orphaned || abandoned) {
        store.sessions.delete(id);
        void session.close("idle", "会话已闲置较长时间，已自动关闭以释放资源");
      }
    }
  }, 30 * 1000);
  store.sweeper.unref?.();
}

export function getSession(id: string | null | undefined) {
  if (!id) return null;
  const session = store.sessions.get(id);
  if (!session || !session.alive) return null;
  session.lastSeen = Date.now();
  return session;
}

export class BusyError extends Error {
  constructor(message: string, readonly retryAfter: number) {
    super(message);
  }
}

/**
 * Picks the session to free when the server is full:
 *   1. nobody is watching it (closed tab), oldest first
 *   2. otherwise the one idle longest, if idle for more than RECLAIM_AFTER_MS
 */
function pickVictim() {
  const now = Date.now();
  const sessions = [...store.sessions.values()];
  const orphan = sessions.filter((s) => s.listenerCount === 0).sort((a, b) => a.lastSeen - b.lastSeen)[0];
  if (orphan) return orphan;
  const idle = sessions.filter((s) => now - s.lastActive > RECLAIM_AFTER_MS).sort((a, b) => a.lastActive - b.lastActive)[0];
  return idle ?? null;
}

/** Seconds until the most idle session becomes reclaimable (for the retry hint). */
function secondsUntilReclaim() {
  const now = Date.now();
  const oldest = Math.min(...[...store.sessions.values()].map((s) => s.lastActive));
  return Math.max(3, Math.ceil((oldest + RECLAIM_AFTER_MS - now) / 1000));
}

export async function createSession(viewport: Partial<Viewport> | undefined, dpr?: unknown) {
  startSweeper();
  // Free space first, then start the (possibly new) Chromium process.
  let freed = 0;
  while (!hasRoomForSession() && store.sessions.size > 0 && freed < 3) {
    const victim = pickVictim();
    if (!victim) break;
    store.sessions.delete(victim.id);
    await victim.close("reclaimed", "由于长时间未操作，你的浏览器会话已被回收，以便其他人使用");
    freed += 1;
  }
  if (!hasRoomForSession() && store.sessions.size > 0) {
    throw new BusyError("服务器当前使用人数已满，正在排队，会自动重试", secondsUntilReclaim());
  }
  const bucket = dprBucket(dpr);
  const browser = await ensureEngine(bucket);
  const session = await RemoteSession.create(browser, clampViewport(viewport), bucket);
  store.sessions.set(session.id, session);
  return session;
}

export async function closeSession(id: string) {
  const session = store.sessions.get(id);
  if (!session) return;
  store.sessions.delete(id);
  await session.close("reset");
}
