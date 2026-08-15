"use client";

import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";

const LONG_PRESS_MS = 480;
const MOVE_CANCEL_PX = 10;

/**
 * Long-press for touch (and pen). Mouse right-click stays on `contextmenu`.
 *
 * Cancels if the finger moves, so scrolling the fleet list does not open menus.
 */
export function useLongPress(onLongPress: (x: number, y: number) => void) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    start.current = null;
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (event.pointerType === "mouse") return;
      fired.current = false;
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        if (!start.current) return;
        fired.current = true;
        onLongPress(start.current.x, start.current.y);
        // Briefly block the synthetic click that follows a long-press.
        window.setTimeout(() => {
          fired.current = false;
        }, 400);
      }, LONG_PRESS_MS);
    },
    [onLongPress],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      if (!start.current) return;
      const dx = Math.abs(event.clientX - start.current.x);
      const dy = Math.abs(event.clientY - start.current.y);
      if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) clear();
    },
    [clear],
  );

  const onPointerUp = useCallback(() => {
    clear();
  }, [clear]);

  const didFire = useCallback(() => fired.current, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    didFire,
  };
}
