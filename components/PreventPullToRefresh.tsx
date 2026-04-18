"use client";
import { useEffect } from "react";

function canScrollUp(el: EventTarget | null): boolean {
  let node = el as Element | null;
  while (node && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    const overflowY = style.overflowY;
    const isScrollable = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
    if (isScrollable && node.scrollTop > 0) return true;
    node = node.parentElement;
  }
  return false;
}

export default function PreventPullToRefresh() {
  useEffect(() => {
    let startY = 0;

    const onTouchStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
    };

    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0].clientY;
      const pullingDown = y > startY;
      if (pullingDown && !canScrollUp(e.target)) {
        e.preventDefault();
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  return null;
}
