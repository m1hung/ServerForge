"use client";

import Link from "next/link";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * A right-click menu.
 *
 * Rendered on `document.body` with an inline `position: fixed`. The `.panel`
 * class is `position: relative`, and several themes add a hover transform;
 * either would take `left`/`top` as an offset from the menu's place in the
 * page instead of from the cursor. Portalling also escapes `main`'s scroll
 * container, which otherwise becomes the containing block.
 */

export function ContextMenu({
  open,
  x,
  y,
  label,
  onClose,
  children,
}: {
  open: boolean;
  x: number;
  y: number;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState<{
    left: number;
    top: number;
    originX: number;
    originY: number;
  } | null>(null);

  const left =
    clamped && clamped.originX === x && clamped.originY === y ? clamped.left : x;
  const top =
    clamped && clamped.originX === x && clamped.originY === y ? clamped.top : y;

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const pad = 8;
    const rect = ref.current.getBoundingClientRect();
    setClamped({
      originX: x,
      originY: y,
      left: Math.min(Math.max(pad, x), window.innerWidth - rect.width - pad),
      top: Math.min(Math.max(pad, y), window.innerHeight - rect.height - pad),
    });
  }, [open, x, y]);

  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ position: "fixed", left, top, zIndex: 70 }}
      className="min-w-[11.5rem] rounded-lg border border-line bg-surface py-1 shadow-overlay"
    >
      {children}
    </div>,
    document.body,
  );
}

export function ContextMenuItem({
  icon: Icon,
  children,
  href,
  disabled,
  danger,
  onSelect,
}: {
  icon?: ComponentType<{ className?: string }>;
  children: ReactNode;
  href?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
}) {
  const className = cn(
    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
    disabled
      ? "cursor-not-allowed text-ink-subtle"
      : danger
        ? "text-danger hover:bg-danger/[0.08]"
        : "text-ink hover:bg-surface-raised hover:text-ink",
  );

  const body = (
    <>
      {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </>
  );

  if (href && !disabled) {
    return (
      <Link role="menuitem" href={href} className={className} onClick={onSelect}>
        {body}
      </Link>
    );
  }

  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={className}
      onClick={() => {
        if (disabled) return;
        onSelect?.();
      }}
    >
      {body}
    </button>
  );
}

export function ContextMenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-line" />;
}
