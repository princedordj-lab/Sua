"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Keyboard-only viewport tracking for elements that should step out of the way
 * while the soft keyboard is open (the floating assistant). The full-height
 * hook below also owns the `--app-vh` variable used by the chat layout.
 */
export function useKeyboardOpen() {
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);

  useEffect(() => {
    let baselineHeight = window.innerHeight;
    let rafId: number | null = null;

    const updateViewport = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const height = window.visualViewport?.height ?? window.innerHeight;
        baselineHeight = Math.max(baselineHeight, window.innerHeight);
        setIsKeyboardOpen(baselineHeight - height > 150);
      });
    };

    const updateOrientation = () => {
      baselineHeight = window.innerHeight;
      updateViewport();
    };

    updateViewport();

    const vv = window.visualViewport;
    vv?.addEventListener("resize", updateViewport);
    window.addEventListener("resize", updateViewport);
    window.addEventListener("orientationchange", updateOrientation);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      vv?.removeEventListener("resize", updateViewport);
      window.removeEventListener("resize", updateViewport);
      window.removeEventListener("orientationchange", updateOrientation);
    };
  }, []);

  return isKeyboardOpen;
}

export function useVisualViewportHeight<T extends HTMLElement = HTMLDivElement>() {
  const containerRef = useRef<T | null>(null);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const rafId = useRef<number | null>(null);
  const baselineHeight = useRef(0);

  useEffect(() => {
    baselineHeight.current = window.innerHeight;

    const updateViewport = () => {
      if (rafId.current) cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(() => {
        const vv = window.visualViewport;
        const height = vv ? vv.height : window.innerHeight;
        const offsetTop = vv ? vv.offsetTop : 0;
        const effectiveHeight = Math.max(0, height - offsetTop);
        baselineHeight.current = Math.max(baselineHeight.current, window.innerHeight);
        const open = baselineHeight.current - height > 150;

        setIsKeyboardOpen(open);
        const target = containerRef.current ?? document.documentElement;
        target.style.setProperty("--app-vh", `${effectiveHeight}px`);
      });
    };

    const updateOrientation = () => {
      baselineHeight.current = window.innerHeight;
      updateViewport();
    };

    updateViewport();

    const vv = window.visualViewport;
    vv?.addEventListener("resize", updateViewport);
    vv?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    window.addEventListener("orientationchange", updateOrientation);

    return () => {
      if (rafId.current) cancelAnimationFrame(rafId.current);
      vv?.removeEventListener("resize", updateViewport);
      vv?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      window.removeEventListener("orientationchange", updateOrientation);
    };
  }, []);

  return { containerRef, isKeyboardOpen };
}
