"use client";

import { useEffect, useState } from "react";

function isStandaloneMode(): boolean {
  if (typeof window === "undefined") return false;
  const byMedia = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  const byIos = typeof (window.navigator as Navigator & { standalone?: boolean }).standalone === "boolean"
    ? !!(window.navigator as Navigator & { standalone?: boolean }).standalone
    : false;
  return byMedia || byIos;
}

export default function PwaRefreshButton() {
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia?.("(display-mode: standalone)");
    const update = () => setStandalone(isStandaloneMode());
    update();
    media?.addEventListener?.("change", update);
    window.addEventListener("pageshow", update);
    return () => {
      media?.removeEventListener?.("change", update);
      window.removeEventListener("pageshow", update);
    };
  }, []);

  useEffect(() => {
    if (!standalone) return;

    let startY = 0;
    let tracking = false;
    let triggered = false;
    const threshold = 110;

    const hasScrollableAncestor = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      if (target.closest('[data-prevent-pull-refresh="1"]')) return true;
      let node: Element | null = target;
      while (node && node !== document.body) {
        if (!(node instanceof HTMLElement)) {
          node = node.parentElement;
          continue;
        }
        const style = window.getComputedStyle(node);
        const overflowY = style.overflowY;
        const canScroll = (overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight;
        if (canScroll) return true;
        node = node.parentElement;
      }
      return false;
    };

    const onTouchStart = (event: TouchEvent) => {
      if (window.scrollY > 0) return;
      if (event.touches.length !== 1) return;
      if (hasScrollableAncestor(event.target)) return;
      startY = event.touches[0].clientY;
      tracking = true;
      triggered = false;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking || triggered) return;
      const currentY = event.touches[0]?.clientY ?? startY;
      const pullDistance = currentY - startY;
      if (pullDistance >= threshold && window.scrollY <= 0) {
        triggered = true;
        tracking = false;
        window.location.reload();
      }
    };

    const onTouchEnd = () => {
      tracking = false;
      triggered = false;
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [standalone]);

  return null;
}
