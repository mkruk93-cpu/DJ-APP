"use client";

import { useEffect, useState } from "react";

interface CacheClearProps {
  version: string;
}

export default function CacheClear({ version }: CacheClearProps) {
  const [cleared, setCleared] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  useEffect(() => {
    // Check if we need to clear cache for this version
    const lastClearedVersion = localStorage.getItem('cache_cleared_version');
    if (lastClearedVersion !== version) {
      clearAllCache();
    }
  }, [version]);

  async function clearAllCache() {
    setIsClearing(true);
    try {
      // Clear localStorage
      const localStorageKeys = Object.keys(localStorage);
      localStorageKeys.forEach(key => {
        if (!key.startsWith('cache_cleared_version')) {
          localStorage.removeItem(key);
        }
      });

      // Clear sessionStorage
      sessionStorage.clear();

      // Clear browser caches
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
      }

      // Clear IndexedDB
      if ('indexedDB' in window) {
        const databases = await indexedDB.databases();
        await Promise.all(databases.map(db => indexedDB.deleteDatabase(db.name || '')));
      }

      // Mark this version as cleared
      localStorage.setItem('cache_cleared_version', version);
      setCleared(true);
    } catch (error) {
      console.error('Error clearing cache:', error);
    } finally {
      setIsClearing(false);
    }
  }

  if (cleared) {
    return null; // Don't render anything after clearing
  }

  if (isClearing) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950">
        <div className="text-center">
          <div className="mb-4 h-8 w-8 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
          <p className="text-sm text-gray-300">Cache wordt gewist...</p>
        </div>
      </div>
    );
  }

  return null;
}
