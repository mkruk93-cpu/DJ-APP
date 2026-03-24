"use client";

import { useEffect } from "react";

// Verhoog dit nummer wanneer je gebruikers wilt dwingen tot een schone start.
// Dit wist caches, service workers en localStorage bij de eerstvolgende laadactie.
const APP_VERSION = "2.4-force-refresh-march-2025";

export default function PwaRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const checkAndCleanup = async () => {
      // 1. Check versie en forceer cleanup indien nodig
      const storedVersion = localStorage.getItem("dj_app_version");
      
      if (storedVersion !== APP_VERSION) {
        console.log(`[PWA] Nieuwe versie gedetecteerd (${APP_VERSION}). Grote schoonmaak...`);
        
        // Unregister bestaande service workers
        if ("serviceWorker" in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          for (const registration of registrations) {
            await registration.unregister();
          }
        }

        // Wis PWA caches
        if ("caches" in window) {
          const keys = await caches.keys();
          for (const key of keys) {
            await caches.delete(key);
          }
        }

        // Wis localStorage (verwijdert oude sessies/fouten)
        localStorage.clear();
        localStorage.setItem("dj_app_version", APP_VERSION);

        // Force immediate reload for users with old cached versions
        localStorage.setItem("dj_app_version", APP_VERSION);
        localStorage.setItem("dj_app_updated_at", Date.now().toString());
        
        // Hard reload with cache bypass
        window.location.href = window.location.href + (window.location.href.includes('?') ? '&' : '?') + '_nocache=' + Date.now();
        return true;
      }
      return false;
    };

    const registerSW = async () => {
      if (!("serviceWorker" in navigator)) return;

      try {
        const registration = await navigator.serviceWorker.register("/sw.js");
        
        // Forceer update check bij laden
        registration.update();

        // Als er een nieuwe SW wacht, forceer activatie (skipWaiting wordt in sw.js vaak afgehandeld, maar hier kunnen we herladen triggeren)
        if (registration.waiting) {
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
      } catch {
        // Ignore registration failures silently in the UI.
      }
    };

    checkAndCleanup().then((reloading) => {
      if (reloading) return;
      if (document.readyState === "complete") {
        registerSW();
      } else {
        window.addEventListener("load", registerSW);
      }
    });

    return () => window.removeEventListener("load", registerSW);
  }, []);

  return null;
}
