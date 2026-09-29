"use client";

import { useEffect, useRef } from "react";
import { Icon } from "./icon";
import type { TranslateInfo } from "@/lib/use-remote-browser";

export const TRANSLATE_LANGUAGES: { code: string; name: string }[] = [
  { code: "zh-CN", name: "简体中文" },
  { code: "zh-TW", name: "繁體中文" },
  { code: "en", name: "English" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "es", name: "Español" },
  { code: "ru", name: "Русский" },
];

export const languageName = (code: string) => TRANSLATE_LANGUAGES.find((l) => l.code === code)?.name ?? code;

type Props = {
  info: TranslateInfo;
  onChangeLanguage: (code: string) => void;
  onForce: () => void;
  onRestore: () => void;
  onHide: () => void;
};

/** Chrome-style bar shown while a page is translated. */
export function TranslateBar({ info, onChangeLanguage, onForce, onRestore, onHide }: Props) {
  const target = languageName(info.lang);
  return (
    <div className={`translate-bar status-${info.status}`} role="status">
      <span className="translate-badge">
        {info.status === "translating" ? <span className="tab-spinner" /> : <Icon name="translate" size={15} />}
      </span>
      <span className="translate-text">
        {info.status === "translating" && <>正在翻译为 {target}…</>}
        {info.status === "done" && <>已{info.source ? `从${info.source}` : ""}翻译为</>}
        {info.status === "same" && <>此网页已经是 {target}</>}
        {info.status === "error" && <>翻译失败，请稍后重试</>}
      </span>
      {info.status === "done" && (
        <select className="translate-select" value={info.lang} onChange={(event) => onChangeLanguage(event.target.value)} aria-label="目标语言">
          {TRANSLATE_LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>{lang.name}</option>
          ))}
        </select>
      )}
      <span className="translate-actions">
        {info.status === "same" && <button onClick={onForce}>仍要翻译</button>}
        {info.status === "error" && <button onClick={onForce}>重试</button>}
        <button onClick={onRestore}>显示原文</button>
        <button className="translate-close" aria-label="隐藏翻译栏" title="隐藏翻译栏（保持翻译）" onClick={onHide}><Icon name="x" size={14} /></button>
      </span>
    </div>
  );
}

type SnippetProps = {
  target: string;
  x: number;
  y: number;
  original: string;
  result: string | null;
  source: string | null;
  error: string | null;
  onCopy: (text: string) => void;
  onClose: () => void;
};

/** Popover with the translation of the selected text. */
export function TranslatePopover({ target, x, y, original, result, source, error, onCopy, onClose }: SnippetProps) {
  const left = typeof window === "undefined" ? x : Math.max(8, Math.min(x, window.innerWidth - 348));
  const top = typeof window === "undefined" ? y : Math.max(8, Math.min(y, window.innerHeight - 240));
  const ref = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape without swallowing that click.
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="translate-popover" style={{ left, top, zIndex: 60 }}>
        <div className="translate-popover-head">
          <span><Icon name="translate" size={14} /> 翻译{source ? `（${source} → ${target}）` : `为${target}`}</span>
          <button aria-label="关闭" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <p className="translate-original">{original.length > 180 ? `${original.slice(0, 180)}…` : original}</p>
        <div className="translate-result">
          {error ? <span className="translate-error">{error}</span> : result === null ? <span className="translate-wait"><span className="tab-spinner" />正在翻译…</span> : result}
        </div>
        {result && (
          <div className="translate-popover-actions">
            <button onClick={() => onCopy(result)}><Icon name="copy" size={13} /> 复制译文</button>
          </div>
        )}
    </div>
  );
}
