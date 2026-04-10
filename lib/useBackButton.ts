"use client";

import { useEffect, useRef, useCallback } from "react";

interface BackButtonHandlerOptions {
  onCloseOverlay?: () => void | undefined;
  onGoBack?: () => void | undefined;
  canGoBack?: boolean;
}

export function useBackButtonHandler({ onCloseOverlay, onGoBack, canGoBack = false }: BackButtonHandlerOptions) {
  const lastPressTime = useRef<number>(0);
  const toastShown = useRef<number>(0);

  const handleBackPress = useCallback(() => {
    const now = Date.now();
    
    // First, try to close an overlay
    if (onCloseOverlay) {
      onCloseOverlay();
      return;
    }

    // If can go back, do that
    if (canGoBack && onGoBack) {
      onGoBack();
      return;
    }

    // Exit confirmation - show toast if not shown in last 3 seconds
    if (now - toastShown.current > 3000) {
      toastShown.current = now;
      // Show exit confirmation - this would need to be handled by the component
      // returning a special value or using a toast system
      if (window.__showExitConfirmation) {
        window.__showExitConfirmation();
      } else {
        // Fallback: use browser's beforeunload or just log
        console.log("Druk nogmaals op back om af te sluiten");
      }
      
      // Reset after 3 seconds so next press will exit
      setTimeout(() => {
        if (Date.now() - toastShown.current >= 2500) {
          lastPressTime.current = 0;
        }
      }, 3000);
      
      return;
    }

    // Double press to exit - within 2 seconds of last press
    if (now - lastPressTime.current < 2000) {
      window.history.go(-window.history.length);
      // Or use navigator.app.exitApp() for native Android
      const nav = navigator as Navigator & { exitApp?: () => void };
      if (nav.exitApp) {
        nav.exitApp();
      }
    } else {
      lastPressTime.current = now;
    }
  }, [onCloseOverlay, onGoBack, canGoBack]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Handle Android back button
    const handlePopState = (event: PopStateEvent) => {
      event.preventDefault();
      handleBackPress();
    };

    // Push a state so we can intercept the back button
    window.history.pushState({ backHandled: true }, "", window.location.href);

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [handleBackPress]);

  return { handleBackPress };
}

// Helper to find and close the topmost overlay
export function getCloseTopmostOverlay(): (() => void) | undefined {
  if (typeof window === "undefined") return undefined;
  
  // This would need to be customized based on the app's overlay state
  // The stream page would register its close functions
  const handlers = (window.__overlayCloseHandlers || []) as (() => void)[];
  
  if (handlers.length > 0) {
    return handlers[handlers.length - 1]; // Last one is topmost
  }
  
  return undefined;
}

// Register an overlay close handler
export function registerOverlayCloseHandler(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  
  if (!window.__overlayCloseHandlers) {
    window.__overlayCloseHandlers = [];
  }
  
  if (window.__overlayCloseHandlers) {
    window.__overlayCloseHandlers.push(handler);
  }
  
  // Return unregister function
  return () => {
    const idx = window.__overlayCloseHandlers?.indexOf(handler);
    if (idx !== undefined && idx >= 0 && window.__overlayCloseHandlers) {
      window.__overlayCloseHandlers?.splice(idx, 1);
    }
  };
}

declare global {
  interface Window {
    __overlayCloseHandlers?: (() => void)[];
    __showExitConfirmation?: () => void;
  }
}