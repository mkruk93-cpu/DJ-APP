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
      const deltaY = y - startY;
      
      // pullingDown threshold: even a tiny 1px movement is enough to trigger browser logic
      const pullingDown = deltaY > 0;
      
      if (pullingDown && window.scrollY <= 0) {
        // If active (sheet up), we MUST prevent it to allow swiping the sheet down 
        // without Chrome taking over.
        if (active) {
          if (e.cancelable) e.preventDefault();
          return;
        }

        // If not active, only prevent if the element itself cannot scroll up further
        if (!canScrollUp(e.target)) {
          if (e.cancelable) e.preventDefault();
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
