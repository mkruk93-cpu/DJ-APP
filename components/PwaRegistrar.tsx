"use client";

import { useEffect } from "react";

// Verhoog dit nummer wanneer je gebruikers wilt dwingen tot een schone start.
// Dit wist caches, service workers en localStorage bij de eerstvolgende laadactie.
const APP_VERSION = "2.7-pwa-stream-fix-v1";

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

        // Wis localStorage selectief (behou instellingen en afspeellijsten)
        const whitelist = [
          /^spotify-browser:/,
          /^shared-playlists-browser:/,
          /^fallback-selector:/,
          /^radio_nickname$/,
          /^dj_radio_nickname$/,
          /^sb-.*-auth-token$/, // Supabase auth
          /^admin_auth$/,
          /^radio_admin_token$/
        ];

        const keysToKeep: Record<string, string | null> = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && whitelist.some(pattern => pattern.test(key))) {
            keysToKeep[key] = localStorage.getItem(key);
          }
        }

        localStorage.clear();
        for (const [key, value] of Object.entries(keysToKeep)) {
          if (value !== null) localStorage.setItem(key, value);
        }
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
