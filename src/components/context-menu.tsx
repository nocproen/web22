"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icon";

export type MenuItem =
  | { type: "separator" }
  | { type: "item"; label: string; icon?: IconName; hint?: string; disabled?: boolean; accent?: boolean; onSelect: () => void };

type Props = { x: number; y: number; items: MenuItem[]; loading?: boolean; onClose: () => void };

/** Custom right-click menu, positioned at the pointer and kept inside the window. */
export function ContextMenu({ x, y, items, loading, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [focus, setFocus] = useState(-1);

  // Drop leading/trailing/double separators produced by conditional sections.
  const clean: MenuItem[] = [];
  for (const item of items) {
    if (item.type === "separator" && (clean.length === 0 || clean[clean.length - 1].type === "separator")) continue;
    clean.push(item);
  }
  if (clean[clean.length - 1]?.type === "separator") clean.pop();
  const selectable = clean.map((item, i) => (item.type === "item" && !item.disabled ? i : -1)).filter((i) => i >= 0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    setPos({
      left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      top: y + height + margin > window.innerHeight ? Math.max(margin, y - height) : y,
    });
  }, [x, y, clean.length]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        if (!selectable.length) return;
        const current = selectable.indexOf(focus);
        const next = event.key === "ArrowDown" ? (current + 1) % selectable.length : (current - 1 + selectable.length) % selectable.length;
        setFocus(selectable[next < 0 ? 0 : next]);
      } else if (event.key === "Enter" && focus >= 0) {
        event.preventDefault();
        event.stopPropagation();
        const item = clean[focus];
        if (item?.type === "item" && !item.disabled) {
          onClose();
          item.onSelect();
        }
      }
    };
    const onBlur = () => onClose();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [clean, focus, onClose, selectable]);

  return (
    <div
      className="ctx-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
      onWheel={onClose}
    >
      <div ref={ref} className="ctx-menu" role="menu" style={{ left: pos.left, top: pos.top }}>
        {clean.map((item, i) =>
          item.type === "separator" ? (
            <div key={`sep-${i}`} className="ctx-sep" />
          ) : (
            <button
              key={`${item.label}-${i}`}
              role="menuitem"
              className={`ctx-item ${focus === i ? "focused" : ""} ${item.accent ? "accent" : ""}`}
              disabled={item.disabled}
              onMouseEnter={() => setFocus(i)}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              <span className="ctx-icon">{item.icon && <Icon name={item.icon} size={15} />}</span>
              <span className="ctx-label">{item.label}</span>
              {item.hint && <span className="ctx-hint">{item.hint}</span>}
            </button>
          ),
        )}
        {loading && <div className="ctx-loading"><span className="tab-spinner" />正在读取页面信息…</div>}
      </div>
    </div>
  );
}
