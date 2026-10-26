"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Manages iOS Safari and mobile browser visual viewport adjustments.
 * Subscribes to window.visualViewport resize and scroll events in requestAnimationFrame,
 * sets `--app-vh` on the target container ref or root, detects if the virtual
 * keyboard is open (>150px delta). All viewport state stays scoped to the
 * chat container so an App Router-cached Ask Sua route cannot affect other
 * pages after navigation.
 */
export function useVisualViewportHeight<T extends HTMLElement = HTMLDivElement>() {
  const containerRef = useRef<T | null>(null);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const rafId = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const updateViewport = () => {
      if (rafId.current) cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(() => {
        const vv = window.visualViewport;
        const height = vv ? vv.height : window.innerHeight;
        const offsetTop = vv ? vv.offsetTop : 0;
        const effectiveHeight = Math.max(0, height - offsetTop);

        const open = window.innerHeight - (vv ? vv.height : window.innerHeight) > 150;
        setIsKeyboardOpen(open);

        const target = containerRef.current ?? document.documentElement;
        target.style.setProperty("--app-vh", `${effectiveHeight}px`);
      });
    };

    updateViewport();

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", updateViewport);
      vv.addEventListener("scroll", updateViewport);
    }
    window.addEventListener("resize", updateViewport);
    window.addEventListener("orientationchange", updateViewport);

    return () => {
      if (rafId.current) cancelAnimationFrame(rafId.current);
      if (vv) {
        vv.removeEventListener("resize", updateViewport);
        vv.removeEventListener("scroll", updateViewport);
      }
      window.removeEventListener("resize", updateViewport);
      window.removeEventListener("orientationchange", updateViewport);
    };
  }, []);

  return { containerRef, isKeyboardOpen };
}
