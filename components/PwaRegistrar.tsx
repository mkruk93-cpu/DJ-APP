"use client";

import { useEffect } from "react";

export default function PwaRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const register = async () => {
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

    window.addEventListener("load", register);
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
