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

interface PreventPullToRefreshProps {
  active?: boolean;
}

export default function PreventPullToRefresh({ active = false }: PreventPullToRefreshProps) {
  useEffect(() => {
    let startY = 0;

    const onTouchStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
    };

    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0].clientY;
      const pullingDown = y > startY;
      
      // If active is true (sheet expanded), we always want to prevent pull-to-refresh
      // when swiping down from the top area.
      if (pullingDown && (active || !canScrollUp(e.target))) {
        // Only prevent if we are at the top of the window
        if (window.scrollY <= 0) {
          e.preventDefault();
        }
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
    };
  }, [active]);

  return null;
}
