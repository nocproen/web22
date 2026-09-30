"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu, type MenuItem } from "@/components/context-menu";
import { Icon } from "@/components/icon";
import { languageName, TranslateBar, TranslatePopover } from "@/components/translate-bar";
import { RemoteScreen } from "@/components/remote-screen";
import { type ContextInfo, type Quality, useRemoteBrowser } from "@/lib/use-remote-browser";

type QuickLink = { name: string; label: string; url: string; className: string; mark: string };
type HistoryItem = { url: string; title: string; time: number };
type EngineKey = "bing" | "google" | "baidu" | "duckduckgo";

const ENGINES: Record<EngineKey, { name: string; url: (q: string) => string }> = {
  bing: { name: "Bing", url: (q) => `https://www.bing.com/search?q=${q}` },
  google: { name: "Google", url: (q) => `https://www.google.com/search?q=${q}` },
  baidu: { name: "百度", url: (q) => `https://www.baidu.com/s?wd=${q}` },
  duckduckgo: { name: "DuckDuckGo", url: (q) => `https://duckduckgo.com/?q=${q}` },
};

const quickLinks: QuickLink[] = [
  { name: "GitHub", label: "代码仓库", url: "https://github.com", className: "github", mark: "◉" },
  { name: "Google", label: "搜索", url: "https://www.google.com", className: "arcade", mark: "G" },
  { name: "YouTube", label: "视频", url: "https://www.youtube.com", className: "youtube", mark: "▶" },
  { name: "Wikipedia", label: "百科", url: "https://www.wikipedia.org", className: "notion", mark: "W" },
  { name: "Figma", label: "设计", url: "https://www.figma.com", className: "figma", mark: "◆" },
  { name: "Linear", label: "项目管理", url: "https://linear.app", className: "linear", mark: "↗" },
  { name: "百度", label: "中文搜索", url: "https://www.baidu.com", className: "github", mark: "百" },
];

const QUALITY_OPTIONS: { key: Quality; label: string; hint: string }[] = [
  { key: "auto", label: "自动", hint: "根据网速调整运动画面，静止后自动变清晰（推荐）" },
  { key: "smooth", label: "流畅", hint: "运动时明显降低画质，最省带宽" },
  { key: "balanced", label: "均衡", hint: "运动时中等画质" },
  { key: "sharp", label: "清晰", hint: "始终高画质，需要较好的网络" },
];
function formatBandwidth(kbPerSec: number) {
  const mbps = (kbPerSec * 8) / 1024;
  return mbps >= 10 ? `${Math.round(mbps)} Mbps` : `${mbps.toFixed(1)} Mbps`;
}

const HISTORY_KEY = "luma_history";
const ENGINE_KEY = "luma_engine";
const LANG_KEY = "luma_translate_lang";
const EMPTY_INFO: ContextInfo = { prevented: false, link: "", linkText: "", image: "", selection: "", editable: false };
const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text).replace(/\s+/g, " ");

function isBlank(url: string | undefined) {
  return !url || url === "about:blank";
}

function getHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getAddressDisplay(url: string) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function makeDestination(input: string, engine: EngineKey) {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/i.test(value)) return `https://${value}`;
  return ENGINES[engine].url(encodeURIComponent(value));
}

function timeAgo(time: number) {
  const diff = Math.max(0, Date.now() - time) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

function QueueCountdown({ active, limit, retryAt }: { active: number; limit: number; retryAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  return (
    <div className="queue-info">
      {limit > 0 && <span>当前在线 {active} / {limit}</span>}
      <span>{seconds > 0 ? `${seconds} 秒后自动重试` : "正在重试…"}</span>
    </div>
  );
}

export default function HomePage() {
  const rb = useRemoteBrowser();
  const { tabs, activeId, status, command, setActiveId } = rb;
  const [address, setAddress] = useState("");
  const [focused, setFocused] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [engine, setEngine] = useState<EngineKey>("bing");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [toastVisible, setToastVisible] = useState(false);
  const [focusSignal, setFocusSignal] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; info: ContextInfo | null } | null>(null);
  const menuTokenRef = useRef(0);
  const [snippet, setSnippet] = useState<{ x: number; y: number; original: string; result: string | null; source: string | null; error: string | null } | null>(null);
  const [targetLang, setTargetLang] = useState("zh-CN");
  const [hiddenBar, setHiddenBar] = useState<string | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const keyboardFocusRef = useRef<(() => void) | null>(null);

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeId) ?? null, [tabs, activeId]);
  const isHome = !activeTab || isBlank(activeTab.url);

  /* ---------------- persisted preferences ---------------- */
  useEffect(() => {
    try {
      const savedLang = localStorage.getItem(LANG_KEY);
      if (savedLang) setTargetLang(savedLang);
      const saved = localStorage.getItem(ENGINE_KEY) as EngineKey | null;
      if (saved && saved in ENGINES) setEngine(saved);
      setHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as HistoryItem[]);
    } catch {
      /* ignore corrupt storage */
    }
  }, []);

  function chooseEngine(key: EngineKey) {
    setEngine(key);
    localStorage.setItem(ENGINE_KEY, key);
  }

  /* ---------------- record real history ---------------- */
  useEffect(() => {
    if (!activeTab || isBlank(activeTab.url) || activeTab.loading || !/^https?:/.test(activeTab.url)) return;
    const { url, title } = activeTab;
    setHistory((current) => {
      if (current[0]?.url === url && current[0]?.title === title) return current;
      const next = [{ url, title: title || getHost(url), time: Date.now() }, ...current.filter((item) => item.url !== url)].slice(0, 30);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, [activeTab]);

  /* ---------------- address bar sync ---------------- */
  useEffect(() => {
    if (!focused) setAddress(activeTab && !isBlank(activeTab.url) ? activeTab.url : "");
  }, [activeTab, focused]);

  /* ---------------- toast ---------------- */
  useEffect(() => {
    if (!rb.toast) return;
    setToastVisible(true);
    const timer = window.setTimeout(() => setToastVisible(false), 4200);
    return () => window.clearTimeout(timer);
  }, [rb.toast]);

  /* ---------------- actions ---------------- */
  const go = useCallback((input: string) => {
    const value = input.trim();
    if (!value) return;
    const url = makeDestination(value, engine);
    void command("goto", { url });
    setShowMenu(false);
    addressRef.current?.blur();
    setFocusSignal((n) => n + 1);
  }, [command, engine]);

  function submitAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    go(address);
  }

  function activate(id: number) {
    setActiveId(id);
    void command("activate", { tabId: id });
  }

  function newTab() {
    void command("newTab");
    window.setTimeout(() => addressRef.current?.focus(), 120);
  }

  /* ---------------- context menu & translation ---------------- */
  const closeMenu = useCallback(() => {
    menuTokenRef.current += 1;
    setMenu(null);
  }, []);

  useEffect(() => {
    closeMenu();
    setSnippet(null);
  }, [activeId, closeMenu]);

  const openContextMenu = useCallback((at: { x: number; y: number; clientX: number; clientY: number }) => {
    const token = ++menuTokenRef.current;
    setMenu(null);
    setSnippet(null);
    // Show immediately on fast links; on slow ones show the basic menu after 300ms and fill it in.
    const early = window.setTimeout(() => {
      if (menuTokenRef.current === token) setMenu((current) => current ?? { x: at.clientX, y: at.clientY, info: null });
    }, 300);
    void command("context", { x: at.x, y: at.y }).then((res: { info?: ContextInfo } | null) => {
      window.clearTimeout(early);
      if (menuTokenRef.current !== token) return;
      const info = res?.info ?? EMPTY_INFO;
      if (info.prevented) {
        setMenu(null); // the page drew its own menu
        return;
      }
      setMenu({ x: at.clientX, y: at.clientY, info });
    });
  }, [command]);

  function copyText(text: string, message = "已复制") {
    if (!navigator.clipboard) {
      rb.showToast("当前环境不支持复制");
      return;
    }
    navigator.clipboard.writeText(text).then(() => rb.showToast(message), () => rb.showToast("复制失败，请手动复制"));
  }

  async function pasteFromClipboard() {
    setFocusSignal((n) => n + 1);
    try {
      const text = await navigator.clipboard.readText();
      if (text) rb.sendInput({ type: "text", text });
    } catch {
      rb.showToast("浏览器不允许网页读取剪贴板，请直接按 Ctrl+V 粘贴");
    }
  }

  function translatePage(lang: string, force = false) {
    setTargetLang(lang);
    localStorage.setItem(LANG_KEY, lang);
    setHiddenBar(null);
    void command("translate", { lang, force });
  }

  function restoreOriginal() {
    void command("untranslate");
  }

  const closeSnippet = useCallback(() => setSnippet(null), []);

  function translateSelection(text: string, x: number, y: number) {
    setSnippet({ x, y: y + 4, original: text, result: null, source: null, error: null });
    void command("translateText", { text, lang: targetLang }).then((res: { ok?: boolean; text?: string; source?: string | null } | null) => {
      setSnippet((current) => {
        if (!current || current.original !== text) return current;
        return res?.ok
          ? { ...current, result: String(res.text ?? ""), source: res.source ?? null }
          : { ...current, error: "翻译服务暂时不可用，请稍后重试" };
      });
    });
  }

  function buildMenu(info: ContextInfo | null, x: number, y: number): MenuItem[] {
    const item = (label: string, onSelect: () => void, extra: Partial<Extract<MenuItem, { type: "item" }>> = {}): MenuItem => ({ type: "item", label, onSelect, ...extra });
    const sep: MenuItem = { type: "separator" };
    const items: MenuItem[] = [];
    const plain = !info || (!info.link && !info.image && !info.selection && !info.editable);

    if (info?.link) {
      items.push(
        item("在新标签页中打开链接", () => void command("newTab", { url: info.link }), { icon: "external" }),
        item("复制链接地址", () => copyText(info.link, "已复制链接地址"), { icon: "link" }),
        sep,
      );
    }
    if (info?.image) {
      items.push(
        item("在新标签页中打开图片", () => void command("newTab", { url: info.image }), { icon: "image" }),
        item("复制图片地址", () => copyText(info.image, "已复制图片地址"), { icon: "copy" }),
        sep,
      );
    }
    if (info?.selection) {
      const short = shorten(info.selection, 14);
      items.push(
        item("复制", () => copyText(info.selection), { icon: "copy", hint: "Ctrl+C" }),
        item(`翻译“${short}”`, () => translateSelection(info.selection, x, y), { icon: "translate", accent: true }),
        item(`使用 ${ENGINES[engine].name} 搜索“${short}”`, () => void command("newTab", { url: ENGINES[engine].url(encodeURIComponent(info.selection)) }), { icon: "search" }),
        sep,
      );
    }
    if (info?.editable) {
      items.push(
        item("粘贴", () => void pasteFromClipboard(), { icon: "copy", hint: "Ctrl+V" }),
        item("全选", () => { rb.sendInput({ type: "press", key: "Control+a" }); setFocusSignal((n) => n + 1); }, { hint: "Ctrl+A" }),
        sep,
      );
    }
    if (plain) {
      items.push(
        item("后退", () => void command("back"), { icon: "arrow-left", disabled: !activeTab?.canGoBack }),
        item("前进", () => void command("forward"), { icon: "arrow-right", disabled: !activeTab?.canGoForward }),
        item("重新加载", () => void command("reload"), { icon: "refresh" }),
        sep,
      );
    }

    const tr = activeTab?.translate;
    if (tr && tr.status !== "error") items.push(item("显示原文", restoreOriginal, { icon: "translate" }));
    else items.push(item(`翻译成${languageName(targetLang)}`, () => translatePage(targetLang), { icon: "translate", accent: true }));

    if (plain && activeTab && !isBlank(activeTab.url)) {
      items.push(
        sep,
        item("复制网页地址", () => copyText(activeTab.url, "已复制网页地址"), { icon: "link" }),
        item("在真实窗口打开此页", openExternally, { icon: "external" }),
      );
    }
    return items;
  }

  const barKey = activeTab?.translate ? `${activeTab.id}|${activeTab.translate.lang}` : null;
  const showTranslateBar = Boolean(activeTab?.translate && !isHome && barKey !== hiddenBar);

  function openExternally() {
    if (activeTab && !isBlank(activeTab.url)) window.open(activeTab.url, "_blank", "noopener,noreferrer");
  }

  function clearHistory() {
    setHistory([]);
    localStorage.removeItem(HISTORY_KEY);
  }

  const connectionLabel =
    status === "ready" ? "远程 Chromium 已连接"
      : status === "preparing" ? "正在准备浏览器引擎"
      : status === "busy" ? "排队中"
      : status === "ended" ? "会话已结束"
      : status === "error" ? "连接异常"
      : "正在连接";
  const showEngineOverlay = status === "ended" || status === "busy" || (tabs.length === 0 && status !== "ready");

  return (
    <main className="browser-shell" onClick={() => showMenu && setShowMenu(false)}>
      <div className="window-topline" />
      <header className="tab-strip">
        <div className="brand-lockup" aria-label="Luma 浏览器">
          <div className="brand-orb"><span /></div>
          <span className="brand-name">luma</span>
        </div>
        <div className="tabs-list">
          {tabs.map((tab) => (
            <button key={tab.id} className={`browser-tab ${tab.id === activeId ? "active" : ""}`} onClick={() => activate(tab.id)} title={tab.title}>
              <span className={`tab-favicon ${isBlank(tab.url) ? "home-favicon" : "site-favicon"}`}>
                {tab.loading ? <span className="tab-spinner" /> : isBlank(tab.url) ? <Icon name="spark" size={13} /> : <Icon name="globe" size={13} />}
              </span>
              <span className="tab-title">{isBlank(tab.url) ? "新标签页" : tab.title || getHost(tab.url)}</span>
              <span
                className="tab-close"
                role="button"
                aria-label="关闭标签页"
                onClick={(event) => {
                  event.stopPropagation();
                  void command("closeTab", { tabId: tab.id });
                }}
              >
                <Icon name="x" size={14} />
              </span>
            </button>
          ))}
          <button className="new-tab-button" aria-label="新建标签页" onClick={newTab} disabled={status !== "ready"}><Icon name="plus" size={18} /></button>
        </div>
        <div className="window-actions">
          <span className="window-action minimize" />
          <span className="window-action maximize" />
          <span className="window-action close-window" />
        </div>
      </header>

      <div className="toolbar">
        <div className="navigation-actions">
          <button className="toolbar-button" aria-label="后退" disabled={!activeTab?.canGoBack} onClick={() => void command("back")}><Icon name="arrow-left" size={19} /></button>
          <button className="toolbar-button" aria-label="前进" disabled={!activeTab?.canGoForward} onClick={() => void command("forward")}><Icon name="arrow-right" size={19} /></button>
          {activeTab?.loading ? (
            <button className="toolbar-button" aria-label="停止加载" onClick={() => void command("stop")}><Icon name="x" size={18} /></button>
          ) : (
            <button className="toolbar-button" aria-label="刷新" disabled={isHome} onClick={() => void command("reload")}><Icon name="refresh" size={18} /></button>
          )}
        </div>
        <form className={`address-bar ${focused ? "focused" : ""}`} onSubmit={submitAddress}>
          <span className="address-security"><Icon name={activeTab?.url.startsWith("https") ? "lock" : "search"} size={15} /></span>
          <input
            ref={addressRef}
            aria-label="地址栏"
            value={focused ? address : activeTab && !isBlank(activeTab.url) ? getAddressDisplay(activeTab.url) : ""}
            placeholder={`使用 ${ENGINES[engine].name} 搜索，或输入网址`}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              setFocused(true);
              setAddress(activeTab && !isBlank(activeTab.url) ? activeTab.url : "");
              requestAnimationFrame(() => event.target.select());
            }}
            onBlur={() => setFocused(false)}
            spellCheck={false}
            disabled={status !== "ready" && tabs.length === 0}
          />
          {activeTab && !isBlank(activeTab.url) && (
            <button
              type="button"
              className={`address-translate ${activeTab.translate && activeTab.translate.status !== "error" ? "active" : ""}`}
              aria-label={activeTab.translate ? "显示原文" : "翻译此网页"}
              title={activeTab.translate ? "显示原文" : `翻译成${languageName(targetLang)}`}
              onClick={() => (activeTab.translate ? restoreOriginal() : translatePage(targetLang))}
            >
              <Icon name="translate" size={16} />
            </button>
          )}
          {activeTab && !isBlank(activeTab.url) && (
            <button type="button" className="address-copy" aria-label="复制网址" onClick={() => copyText(activeTab.url, "已复制网页地址")}><Icon name="copy" size={15} /></button>
          )}
          <button type="button" className="address-star" aria-label="在真实窗口打开" title="在真实窗口打开" onClick={openExternally}><Icon name="external" size={16} /></button>
        </form>
        <div className="toolbar-right">
          <button type="button" className="toolbar-button mobile-keyboard-button" aria-label="打开远程网页键盘" title="打开远程网页键盘" disabled={status !== "ready" || isHome} onClick={() => keyboardFocusRef.current?.()}><Icon name="keyboard" size={18} /></button>
          <span className={`privacy-pill status-${status}`} title={connectionLabel}><Icon name="shield" size={16} /><span>{status === "ready" ? "隔离浏览" : "连接中"}</span></span>
          <div className="menu-wrap">
            <button className="toolbar-button" aria-label="浏览器菜单" onClick={(event) => { event.stopPropagation(); setShowMenu((value) => !value); }}><Icon name="dots" size={19} /></button>
            {showMenu && (
              <div className="browser-menu" onClick={(event) => event.stopPropagation()}>
                <div className="menu-label">默认搜索引擎</div>
                <div className="engine-options">
                  {(Object.keys(ENGINES) as EngineKey[]).map((key) => (
                    <button key={key} className={engine === key ? "selected" : ""} onClick={() => chooseEngine(key)}>{ENGINES[key].name}</button>
                  ))}
                </div>
                <div className="menu-label">画质</div>
                <div className="engine-options quality-options">
                  {QUALITY_OPTIONS.map((option) => (
                    <button key={option.key} className={rb.quality === option.key ? "selected" : ""} onClick={() => rb.setQuality(option.key)} title={option.hint}>
                      {option.label}
                    </button>
                  ))}
                </div>
                <div className="menu-separator" />
                <button onClick={() => { setShowMenu(false); newTab(); }}><Icon name="plus" size={16} />新建标签页</button>
                <button onClick={() => { setShowMenu(false); openExternally(); }} disabled={isHome}><Icon name="external" size={16} />在真实窗口打开当前页</button>
                <button onClick={() => { setShowMenu(false); clearHistory(); }}><Icon name="clock" size={16} />清除浏览记录</button>
                <div className="menu-separator" />
                <button onClick={() => { setShowMenu(false); rb.resetSession(); }}><Icon name="refresh" size={16} />重置浏览器会话<span className="menu-shortcut">清除 Cookie</span></button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="browser-content">
        {activeTab?.loading && <div className="loading-line" />}
        {showTranslateBar && activeTab?.translate && (
          <TranslateBar
            info={activeTab.translate}
            onChangeLanguage={(code) => translatePage(code)}
            onForce={() => translatePage(activeTab.translate?.lang ?? targetLang, true)}
            onRestore={restoreOriginal}
            onHide={() => setHiddenBar(barKey)}
          />
        )}

        <RemoteScreen
          frameHandlerRef={rb.frameHandlerRef}
          scrollHandlerRef={rb.scrollHandlerRef}
          viewport={rb.viewport}
          sendInput={rb.sendInput}
          onResize={rb.resize}
          onFrameDrawn={rb.frameDrawn}
          onContextMenu={openContextMenu}
          keyboardFocusRef={keyboardFocusRef}
          cursor={rb.cursor}
          hidden={isHome}
          focusSignal={focusSignal}
        />

        {isHome && (
          <div className="home-layer">
            <div className="home-view">
              <section className="hero-panel">
                <div className="hero-copy">
                  <div className="eyebrow"><span className="eyebrow-dot" />远程隔离浏览</div>
                  <h1>更安静地<br /><em>浏览整个网络。</em></h1>
                  <p>网页运行在服务器上的真实 Chromium 中，你的设备只接收画面。登录、人机验证、弹窗和新标签页都能正常使用。</p>
                </div>
                <div className="hero-orbit" aria-hidden="true">
                  <div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" />
                  <div className="orbit-core"><Icon name="spark" size={30} /></div>
                  <span className="star star-one">✦</span><span className="star star-two">✦</span><span className="star star-three">·</span>
                </div>
              </section>

              <section className="home-main">
                <form className="hero-search" onSubmit={(event) => { event.preventDefault(); const input = event.currentTarget.elements.namedItem("q") as HTMLInputElement; go(input.value); input.value = ""; }}>
                  <Icon name="search" size={20} />
                  <input name="q" aria-label="搜索" placeholder={`使用 ${ENGINES[engine].name} 搜索，或输入网址`} disabled={status !== "ready"} autoComplete="off" />
                  <span className="search-shortcut">{ENGINES[engine].name}</span>
                </form>
                <div className="section-heading"><div><span className="section-kicker">快捷方式</span><h2>从这里开始</h2></div></div>
                <div className="shortcuts-grid">
                  {quickLinks.map((link) => (
                    <button className="shortcut-card" key={link.name} onClick={() => go(link.url)} disabled={status !== "ready"}>
                      <span className={`shortcut-mark ${link.className}`}>{link.mark}</span>
                      <span className="shortcut-text"><strong>{link.name}</strong><small>{link.label}</small></span>
                      <Icon name="arrow-right" size={16} />
                    </button>
                  ))}
                  <button className="shortcut-card add-shortcut" onClick={() => addressRef.current?.focus()}>
                    <span className="shortcut-mark add-mark"><Icon name="plus" size={18} /></span>
                    <span className="shortcut-text"><strong>输入网址</strong><small>访问任意网站</small></span>
                  </button>
                </div>
              </section>

              <aside className="home-sidebar">
                <div className="sidebar-heading"><div><span className="section-kicker">最近访问</span><h2>继续上次的浏览</h2></div>{history.length > 0 && <button className="icon-plain" aria-label="清除浏览记录" title="清除浏览记录" onClick={clearHistory}><Icon name="x" size={16} /></button>}</div>
                <div className="recent-list">
                  {history.length === 0 && <p className="recent-empty">还没有浏览记录。打开的网页会显示在这里（仅保存在本机）。</p>}
                  {history.slice(0, 5).map((item) => (
                    <button className="recent-item" key={item.url} onClick={() => go(item.url)}>
                      <span className="recent-mark github">{getHost(item.url).slice(0, 1).toUpperCase()}</span>
                      <span className="recent-copy"><strong>{item.title}</strong><small>{getHost(item.url)} <span>·</span> {timeAgo(item.time)}</small></span>
                      <Icon name="arrow-right" size={15} />
                    </button>
                  ))}
                </div>
                <div className="privacy-card">
                  <div className="privacy-card-top"><span className="privacy-icon"><Icon name="shield" size={18} /></span><span className="privacy-status">隔离运行</span><span className="privacy-check">✓</span></div>
                  <strong>网页代码不会在你的设备上执行。</strong>
                  <p>会话闲置 10 分钟后自动销毁；可随时在菜单中重置会话并清除 Cookie。</p>
                </div>
              </aside>
            </div>
          </div>
        )}

        {showEngineOverlay && (
          <div className="engine-overlay">
            <div className="engine-card">
              {status === "ended" ? (
                <>
                  <span className="engine-icon ended"><Icon name="clock" size={20} /></span>
                  <strong>浏览器会话已结束</strong>
                  <p>{rb.message}</p>
                  <button className="engine-action" onClick={rb.resetSession}><Icon name="refresh" size={15} />开始新的会话</button>
                </>
              ) : status === "busy" ? (
                <>
                  <span className="engine-spinner" />
                  <strong>正在排队</strong>
                  <p>{rb.message}</p>
                  {rb.queue && <QueueCountdown active={rb.queue.active} limit={rb.queue.limit} retryAt={rb.queue.retryAt} />}
                </>
              ) : status === "error" ? (
                <>
                  <span className="engine-error-dot" />
                  <strong>连接遇到问题</strong>
                  <p>{rb.message}</p>
                  <button className="engine-action" onClick={rb.resetSession}><Icon name="refresh" size={15} />立即重试</button>
                </>
              ) : (
                <>
                  <span className="engine-spinner" />
                  <strong>{status === "preparing" ? "正在准备浏览器引擎" : "正在连接远程浏览器"}</strong>
                  <p>{rb.message || "请稍候…"}</p>
                </>
              )}
            </div>
          </div>
        )}

        {status === "reconnecting" && tabs.length > 0 && <div className="reconnect-banner">{rb.message}</div>}

        {rb.toast && <div className={`toast ${toastVisible ? "visible" : ""}`} key={rb.toast.id}>{rb.toast.message}</div>}
        {menu && <ContextMenu x={menu.x} y={menu.y} items={buildMenu(menu.info, menu.x, menu.y)} loading={menu.info === null} onClose={closeMenu} />}
        {snippet && (
          <TranslatePopover
            target={languageName(targetLang)}
            x={snippet.x}
            y={snippet.y}
            original={snippet.original}
            result={snippet.result}
            source={snippet.source}
            error={snippet.error}
            onCopy={(text) => copyText(text, "已复制译文")}
            onClose={closeSnippet}
          />
        )}
      </div>

      <footer className="status-bar">
        <span><span className={`online-dot status-${status}`} />{connectionLabel}</span>
        {status === "ready" && (
          <span className="net-stats" title={rb.transport === "ws" ? "WebSocket 低延迟通道" : "HTTP 兼容通道（WebSocket 不可用）"}>
            <span className={`net-badge ${rb.transport === "ws" ? "fast" : "slow"}`}>{rb.transport === "ws" ? "WS" : "HTTP"}</span>
            {rb.stats.rtt !== null && <span className={rb.stats.rtt > 250 ? "net-warn" : ""}>延迟 {rb.stats.rtt} ms</span>}
            <span>{rb.stats.fps} 帧/秒</span>
            {rb.stats.bw !== null && <span className={rb.stats.bw < 400 ? "net-warn" : ""}>带宽 {formatBandwidth(rb.stats.bw)}</span>}
            {rb.stats.q !== null && <span>画质 {rb.stats.q}{rb.stats.scale < 1 ? ` · ${Math.round(rb.stats.scale * 100)}%` : ""}{rb.quality === "auto" ? "（自动）" : ""}</span>}
          </span>
        )}
        <span>{activeTab && !isBlank(activeTab.url) ? getHost(activeTab.url) : "新标签页"} · 远程渲染 <Icon name="shield" size={13} /></span>
      </footer>
    </main>
  );
}
