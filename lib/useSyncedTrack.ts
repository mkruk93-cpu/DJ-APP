"use client";

import { useEffect, useRef, useState } from "react";
import type { Track } from "@/lib/types";

export function useSyncedTrack(track: Track | null | undefined): Track | null {
  const [visibleTrack, setVisibleTrack] = useState<Track | null>(track ?? null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (!track) {
      setVisibleTrack(null);
      return;
    }

    // started_at=0 is used as loading state; show immediately.
    if (!track.started_at || track.started_at <= Date.now()) {
      setVisibleTrack(track);
      return;
    }

    const delayMs = Math.max(0, track.started_at - Date.now());
    timerRef.current = setTimeout(() => {
      setVisibleTrack(track);
      timerRef.current = null;
    }, delayMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [track]);

  return visibleTrack;
}
