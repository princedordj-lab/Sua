"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { SuaChatMark } from "./sua-chat-icon";
import { useKeyboardOpen } from "@/hooks/use-visual-viewport";

const STORAGE_KEY = "sua:assistant-position";
const FAB_SIZE = 56;
const EDGE = 12;
const DRAG_THRESHOLD = 6;

type Point = { x: number; y: number };

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function maxLeft() {
  return Math.max(EDGE, window.innerWidth - FAB_SIZE - EDGE);
}

function maxTop() {
  return Math.max(EDGE, window.innerHeight - FAB_SIZE - EDGE);
}

function pointFromRatio(fx: number, fy: number): Point {
  return {
    x: clamp(fx * window.innerWidth - FAB_SIZE / 2, EDGE, maxLeft()),
    y: clamp(fy * window.innerHeight - FAB_SIZE / 2, EDGE, maxTop()),
  };
}

function readStoredPosition(): { fx: number; fy: number } | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { fx, fy } = value as { fx?: unknown; fy?: unknown };
    if (typeof fx !== "number" || typeof fy !== "number") return null;
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
    return { fx: clamp(fx, 0, 1), fy: clamp(fy, 0, 1) };
  } catch {
    return null;
  }
}

function writeStoredPosition(point: Point) {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        fx: (point.x + FAB_SIZE / 2) / window.innerWidth,
        fy: (point.y + FAB_SIZE / 2) / window.innerHeight,
      }),
    );
  } catch {
    // Position memory is best-effort.
  }
}

/**
 * Draggable mobile-only shortcut to Ask Sua. Rendered from the root layout so
 * every signed-in route gets it; hidden on the chat screen, while signed out,
 * while the soft keyboard is open, and above the mobile breakpoint by CSS.
 */
export function SuaAssistantFab() {
  const router = useRouter();
  const pathname = usePathname();
  const { isLoaded, isSignedIn } = useAuth();
  const keyboardOpen = useKeyboardOpen();

  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const positionRef = useRef<Point | null>(null);
  const suppressClick = useRef(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const isAskSua =
    pathname === "/app/ask-sua" || pathname.startsWith("/app/ask-sua/");
  const isAppRoute = pathname === "/app" || pathname.startsWith("/app/");

  // Position lives on the DOM node instead of React state: dragging should not
  // re-render the tree, and the stored position is only readable after mount.
  const moveTo = useCallback((point: Point | null) => {
    positionRef.current = point;
    const node = buttonRef.current;
    if (!node) return;
    if (!point) {
      node.style.removeProperty("left");
      node.style.removeProperty("top");
      return;
    }
    node.style.left = `${point.x}px`;
    node.style.top = `${point.y}px`;
  }, []);

  const attachButton = useCallback(
    (node: HTMLButtonElement | null) => {
      buttonRef.current = node;
      if (!node) return;
      const stored = readStoredPosition();
      if (stored) moveTo(pointFromRatio(stored.fx, stored.fy));
    },
    [moveTo],
  );

  useEffect(() => {
    const handleResize = () => {
      const stored = readStoredPosition();
      if (stored) {
        moveTo(pointFromRatio(stored.fx, stored.fy));
        return;
      }
      const current = positionRef.current;
      if (current) {
        moveTo({
          x: clamp(current.x, EDGE, maxLeft()),
          y: clamp(current.y, EDGE, maxTop()),
        });
      }
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, [moveTo]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      moved: false,
    };
    suppressClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

    drag.moved = true;
    suppressClick.current = true;
    setDragging(true);
    moveTo({
      x: clamp(drag.originX + dx, EDGE, maxLeft()),
      y: clamp(drag.originY + dy, EDGE, maxTop()),
    });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) return;

    const point = {
      x: clamp(drag.originX + (event.clientX - drag.startX), EDGE, maxLeft()),
      y: clamp(drag.originY + (event.clientY - drag.startY), EDGE, maxTop()),
    };
    moveTo(point);
    writeStoredPosition(point);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    dragRef.current = null;
    setDragging(false);
    suppressClick.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    router.push("/app/ask-sua");
  };

  if (isAskSua) return null;

  return (
    <button
      ref={attachButton}
      type="button"
      className={[
        "sua-assistant-fab",
        isAppRoute ? "is-app-route" : "",
        dragging ? "is-dragging" : "",
        keyboardOpen ? "is-keyboard-open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="Ask Sua"
      title="Ask Sua"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onClick={handleClick}
    >
      <span className="sua-assistant-fab-plate" aria-hidden="true">
        <SuaChatMark size={40} />
      </span>
    </button>
  );
}
