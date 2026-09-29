/**
 * Script injected into every document of the remote browser (via addInitScript).
 *
 *  - __lumaCtxInfo(x, y): what's under the pointer for our custom context menu,
 *    and whether the page handled `contextmenu` itself (then we stay out of the way).
 *  - __lumaTr: in-page translation. Collects text nodes nearest the viewport first,
 *    applies translations, watches for new content / scrolling, and restores originals.
 */
export const PAGE_RUNTIME = String.raw`(() => {
  if (window.__lumaRuntime) return;
  window.__lumaRuntime = true;

  /* ---------------- context menu ---------------- */
  let lastCtx = null;
  let lastCtxAt = 0;
  addEventListener("contextmenu", (e) => { lastCtx = e; lastCtxAt = Date.now(); }, true);

  const clip = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");

  window.__lumaCtxInfo = (x, y) => {
    const prevented = !!(lastCtx && Date.now() - lastCtxAt < 2000 && lastCtx.defaultPrevented);
    lastCtx = null;
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    const link = el && el.closest ? el.closest("a[href]") : null;
    const img = el && el.closest ? el.closest("img") : null;
    const editable = el && el.closest
      ? el.closest("textarea, input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]), [contenteditable]:not([contenteditable=false])")
      : null;
    let selection = "";
    const active = document.activeElement;
    if (active && typeof active.selectionStart === "number" && typeof active.value === "string" && active.selectionEnd !== null) {
      selection = active.value.slice(active.selectionStart, active.selectionEnd);
    }
    if (!selection) selection = String(window.getSelection() || "");
    return {
      prevented,
      link: link ? clip(link.href, 4000) : "",
      linkText: link ? clip((link.innerText || link.textContent || "").trim(), 200) : "",
      image: img ? clip(img.currentSrc || img.src, 4000) : "",
      selection: clip(selection.trim(), 5000),
      editable: !!editable,
    };
  };

  /* ---------------- translation ---------------- */
  const SKIP = new Set(["script", "style", "noscript", "textarea", "code", "pre", "kbd", "samp", "var", "svg", "math", "canvas", "iframe", "object", "template", "input", "select"]);
  const LETTER = /\p{L}/u;
  const ATTRS = ["placeholder", "title", "aria-label"];

  let active = false;
  let lang = "";
  let observer = null;
  let notifyTimer = 0;
  let nextId = 1;
  let done = new WeakSet();            // text nodes already handled (translated or queued)
  let attrDone = new WeakMap();        // element -> Set of attribute names handled
  const queued = new Map();            // id -> item awaiting a translation
  const originals = new Map();         // text node -> { original, translated }
  const attrOriginals = new Map();     // element -> { attr: { original, translated } }
  let titleOriginal = null;
  let titleTranslated = null;

  function notify(kind) {
    if (!active) return;
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => { try { window.__lumaNotify && window.__lumaNotify(kind); } catch (e) {} }, 350);
  }

  function onMutations(list) {
    let dirty = false;
    for (const m of list) {
      if (m.type === "characterData") {
        const rec = originals.get(m.target);
        if (rec && m.target.nodeValue === rec.translated) continue; // our own write
        if (rec) originals.delete(m.target);
        done.delete(m.target);
        dirty = true;
      } else if (m.type === "childList") {
        if (m.addedNodes.length) dirty = true;
      } else {
        dirty = true; // class/style/hidden changes may reveal untranslated text
      }
    }
    if (dirty) notify("dom");
  }

  function onScroll() { notify("scroll"); }

  function start(target) {
    if (active && lang === target) return;
    if (active) restore();
    active = true;
    lang = target;
    document.documentElement.setAttribute("data-luma-translated", target);
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["class", "style", "hidden", "open", "aria-hidden", "aria-expanded"],
    });
    addEventListener("scroll", onScroll, { passive: true, capture: true });
    addEventListener("resize", onScroll, { passive: true });
  }

  function distance(rect, vh) {
    if (rect.bottom < 0) return -rect.bottom;
    if (rect.top > vh) return rect.top - vh;
    return 0;
  }

  /** Untranslated strings nearest the viewport (within ~1.5 screens), up to the given limits. */
  function collect(maxItems, maxChars) {
    if (!active) return [];
    const root = document.body || document.documentElement;
    const vh = innerHeight;
    const range = vh * 1.5;
    const rects = new Map();
    const rectOf = (el) => {
      let r = rects.get(el);
      if (r === undefined) {
        r = el.getClientRects().length ? el.getBoundingClientRect() : null;
        rects.set(el, r);
      }
      return r;
    };
    const candidates = [];

    if (titleOriginal === null && document.title && LETTER.test(document.title)) {
      candidates.push({ kind: "title", text: document.title.trim(), dist: -1 });
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          if (SKIP.has(n.localName) || n.getAttribute("translate") === "no" || (n.classList && n.classList.contains("notranslate")) || n.isContentEditable) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_SKIP;
        }
        if (done.has(n)) return NodeFilter.FILTER_SKIP;
        const v = n.nodeValue;
        return v && LETTER.test(v) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent) continue;
      const rect = rectOf(parent);
      if (!rect) continue; // hidden: picked up later if it becomes visible
      const dist = distance(rect, vh);
      if (dist > range) continue;
      const raw = n.nodeValue;
      const text = raw.trim();
      if (!text || text.length > 5000) continue;
      candidates.push({ kind: "text", node: n, raw, text, dist });
    }

    for (const el of root.querySelectorAll("[placeholder], [title], [aria-label]")) {
      if (el.closest("[translate=no], .notranslate")) continue;
      const handled = attrDone.get(el);
      for (const attr of ATTRS) {
        const value = el.getAttribute(attr);
        if (!value || !LETTER.test(value) || (handled && handled.has(attr))) continue;
        if (attr !== "placeholder" && attr !== "title" && !(el.localName === "input" || el.localName === "button")) continue;
        const rect = rectOf(el);
        if (!rect) continue;
        const dist = distance(rect, vh);
        if (dist > range) continue;
        candidates.push({ kind: "attr", el, attr, text: value.trim(), dist: dist + 1 });
      }
    }

    candidates.sort((a, b) => a.dist - b.dist);
    const out = [];
    let chars = 0;
    for (const c of candidates) {
      if (out.length >= maxItems || chars + c.text.length > maxChars) break;
      const id = nextId++;
      if (c.kind === "text") done.add(c.node);
      else if (c.kind === "attr") {
        let set = attrDone.get(c.el);
        if (!set) attrDone.set(c.el, (set = new Set()));
        set.add(c.attr);
      } else titleOriginal = document.title;
      queued.set(id, c);
      out.push([id, c.text]);
      chars += c.text.length;
    }
    return out;
  }

  function apply(pairs) {
    let applied = 0;
    for (const [id, translated] of pairs) {
      const item = queued.get(id);
      if (!item) continue;
      queued.delete(id);
      if (!active || typeof translated !== "string") continue;
      if (item.kind === "text") {
        const node = item.node;
        if (!node.isConnected || node.nodeValue !== item.raw) { done.delete(node); continue; }
        const lead = item.raw.match(/^\s*/)[0];
        const trail = item.raw.match(/\s*$/)[0];
        const value = lead + translated + trail;
        originals.set(node, { original: item.raw, translated: value });
        node.nodeValue = value;
        applied += 1;
      } else if (item.kind === "attr") {
        const el = item.el;
        if (el.getAttribute(item.attr) !== item.text && el.getAttribute(item.attr)?.trim() !== item.text) continue;
        let rec = attrOriginals.get(el);
        if (!rec) attrOriginals.set(el, (rec = {}));
        rec[item.attr] = { original: el.getAttribute(item.attr), translated };
        el.setAttribute(item.attr, translated);
        applied += 1;
      } else if (item.kind === "title") {
        titleTranslated = translated;
        document.title = translated;
        applied += 1;
      }
    }
    return applied;
  }

  function restore() {
    active = false;
    clearTimeout(notifyTimer);
    if (observer) observer.disconnect();
    observer = null;
    removeEventListener("scroll", onScroll, { capture: true });
    removeEventListener("resize", onScroll);
    for (const [node, rec] of originals) if (node.nodeValue === rec.translated) node.nodeValue = rec.original;
    for (const [el, rec] of attrOriginals) {
      for (const attr of Object.keys(rec)) if (el.getAttribute(attr) === rec[attr].translated) el.setAttribute(attr, rec[attr].original);
    }
    if (titleOriginal !== null && document.title === titleTranslated) document.title = titleOriginal;
    originals.clear();
    attrOriginals.clear();
    queued.clear();
    titleOriginal = null;
    titleTranslated = null;
    document.documentElement.removeAttribute("data-luma-translated");
    // Everything becomes eligible again for a future translation (WeakSets can't be cleared, so swap them).
    done = new WeakSet();
    attrDone = new WeakMap();
  }

  window.__lumaTr = {
    start,
    collect: (maxItems, maxChars) => collect(maxItems, maxChars),
    apply,
    restore,
    pageLang: () => (document.documentElement.getAttribute("lang") || "").toLowerCase(),
    isActive: () => active,
  };
})();`;
