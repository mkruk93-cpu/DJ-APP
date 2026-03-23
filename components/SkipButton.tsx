"use client";

import { useState, useEffect } from "react";
import { useRadioStore } from "@/lib/radioStore";
import { getSocket } from "@/lib/socket";
import { useAuth } from "@/lib/authContext";
import { getRadioToken } from "@/lib/auth";
import { useIsAdmin } from "@/lib/useIsAdmin";

const ANYONE_SKIP_AFTER = 300;

export default function SkipButton({ compact = false }: { compact?: boolean }) {
  const mode = useRadioStore((s) => s.mode);
  const voteState = useRadioStore((s) => s.voteState);
  const currentTrack = useRadioStore((s) => s.currentTrack);
  const listenerCount = useRadioStore((s) => s.listenerCount);
  const modeSettings = useRadioStore((s) => s.modeSettings);
  const skipLocked = useRadioStore((s) => s.skipLocked);
  const [voted, setVoted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const admin = useIsAdmin();

  useEffect(() => {
    if (!currentTrack?.started_at) { setElapsed(0); return; }
    function tick() {
      if (!currentTrack?.started_at) return;
      setElapsed(Math.max(0, Math.floor((Date.now() - currentTrack.started_at) / 1000)));
    }
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [currentTrack]);

  useEffect(() => {
    setVoted(false);
  }, [currentTrack?.id]);

  useEffect(() => {
    if (!voteState) setVoted(false);
  }, [voteState]);

  if (!currentTrack) return null;

  const isLongTrack = (currentTrack.duration ?? 0) > 600;
  const anyoneCanSkip = isLongTrack && elapsed >= ANYONE_SKIP_AFTER;
  const timeUntilSkip = ANYONE_SKIP_AFTER - elapsed;

  function handleAdminSkip() {
    if (skipLocked) return;
    getSocket().emit("track:skip", { isAdmin: true, token: getRadioToken() });
  }

  function handleVoteSkip() {
    if (skipLocked) return;
    getSocket().emit("vote:skip", {});
    setVoted(true);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("skip-vote-cast"));
    }
  }

  function handleAnyoneSkip() {
    if (skipLocked) return;
    getSocket().emit("track:skip", { token: getRadioToken() });
  }

  const threshold = modeSettings.democracy_threshold;
  // Use server-provided required value if available, otherwise calculate locally
  const needed = voteState?.required ?? Math.max(1, Math.ceil(listenerCount * threshold / 100));
  const currentVotes = voteState?.votes ?? 0;

  if (compact) {
    return (
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
        {skipLocked && (
          <span className="rounded border border-amber-600/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
            Laden...
          </span>
        )}

        {mode === "democracy" && (
          <>
            <button
              onClick={handleVoteSkip}
              disabled={skipLocked || (voted && !admin)}
              className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition ${
                skipLocked
                  ? "border-gray-700 bg-gray-800/50 text-gray-600 cursor-not-allowed"
                  : voted
                  ? "border-violet-500/50 bg-violet-500/10 text-violet-400"
                  : "border-gray-700 bg-gray-800 text-gray-300 hover:border-violet-500 hover:text-white"
              }`}
            >
              {voted ? "Gestemd" : "Stem skip"}
              <span className="rounded-full bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-violet-300">
                {currentVotes}/{needed}
              </span>
            </button>
            {anyoneCanSkip && (
              <button
                onClick={handleAnyoneSkip}
                disabled={skipLocked}
                className={`rounded-md border px-2 py-1 text-xs font-medium transition ${
                  skipLocked
                    ? "border-gray-700 bg-gray-800/50 text-gray-600 cursor-not-allowed"
                    : "border-orange-500/30 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20"
                }`}
              >
                Skip
              </button>
            )}
            {admin && (
              <button
                onClick={handleAdminSkip}
                disabled={skipLocked}
                className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                  skipLocked
                    ? "bg-gray-800/50 text-gray-600 cursor-not-allowed"
                    : "bg-red-600/20 text-red-400 hover:bg-red-600/30"
                }`}
              >
                Skip
              </button>
            )}
          </>
        )}

        {mode === "party" && (
          <button
            onClick={() => { if (!skipLocked) getSocket().emit("track:skip", { token: getRadioToken() }); }}
            disabled={skipLocked}
            className={`rounded-md border px-2 py-1 text-xs font-medium transition ${
              skipLocked
                ? "border-gray-700 bg-gray-800/50 text-gray-600 cursor-not-allowed"
                : "border-gray-700 bg-gray-800 text-gray-300 hover:border-violet-500 hover:text-white"
            }`}
          >
            Skip
          </button>
        )}

        {(mode === "jukebox" || mode === "radio" || mode === "dj") && (
          <>
            {anyoneCanSkip && (
              <button
                onClick={handleAnyoneSkip}
                disabled={skipLocked}
                className={`rounded-md border px-2 py-1 text-xs font-medium transition ${
                  skipLocked
                    ? "border-gray-700 bg-gray-800/50 text-gray-600 cursor-not-allowed"
                    : "border-orange-500/30 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20"
                }`}
              >
                Skip
              </button>
            )}
            {admin && (
              <button
                onClick={handleAdminSkip}
                disabled={skipLocked}
                className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                  skipLocked
                    ? "bg-gray-800/50 text-gray-600 cursor-not-allowed"
                    : "bg-red-600/20 text-red-400 hover:bg-red-600/30"
                }`}
              >
                Skip
              </button>
            )}
          </>
        )}

        {isLongTrack && !anyoneCanSkip && timeUntilSkip > 0 && (
          <span className="text-[10px] text-gray-500">
            skip {Math.floor(timeUntilSkip / 60)}:{String(timeUntilSkip % 60).padStart(2, "0")}
          </span>
        )}
      </div>
    );
  }

  if (mode === "democracy") {
    const hasVotes = voteState && voteState.votes > 0;

    return (
      <div className="flex flex-col gap-1.5">
        {skipLocked && (
          <p className="text-xs font-medium text-amber-400 animate-pulse">Volgende nummer wordt geladen…</p>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={handleVoteSkip}
            disabled={skipLocked || (voted && !admin)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
              skipLocked
                ? "border-gray-700 bg-gray-800/50 text-gray-600 cursor-not-allowed"
                : voted
                ? "border-violet-500/50 bg-violet-500/10 text-violet-400"
                : "border-gray-700 bg-gray-800 text-gray-300 hover:border-violet-500 hover:text-white"
            }`}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 11l5-5m0 0l5 5m-5-5v12" />
            </svg>
            {voted ? "Gestemd!" : "Stem skip"}
            {hasVotes && (
              <span className="ml-1 rounded-full bg-violet-500/20 px-2 py-0.5 text-xs font-semibold text-violet-400">
                {currentVotes}/{needed}
              </span>
            )}
          </button>
          {anyoneCanSkip && (
            <button
              onClick={handleAnyoneSkip}
              disabled={skipLocked}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                skipLocked
                  ? "border-gray-700 bg-gray-800/50 text-gray-600 cursor-not-allowed"
                  : "border-orange-500/30 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20"
              }`}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              Skip
            </button>
          )}
          {admin && (
            <button
              onClick={handleAdminSkip}
              disabled={skipLocked}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                skipLocked
                  ? "bg-gray-800/50 text-gray-600 cursor-not-allowed"
                  : "bg-red-600/20 text-red-400 hover:bg-red-600/30"
              }`}
            >
              Skip
            </button>
          )}
        </div>
        {hasVotes && !skipLocked && (
          <p className="text-xs text-gray-500">
            {currentVotes} van {needed} stemmen nodig om te skippen
            {voteState.timer != null && voteState.timer > 0 && (
              <span className="ml-1 text-yellow-400">
                — nog {voteState.timer}s
              </span>
            )}
          </p>
        )}
        {isLongTrack && !anyoneCanSkip && timeUntilSkip > 0 && (
          <p className="text-xs text-gray-500">
            Iedereen kan skippen over {Math.floor(timeUntilSkip / 60)}:{String(timeUntilSkip % 60).padStart(2, "0")}
          </p>
        )}
      </div>
    );
  }

  if (mode === "party") {
    return (
      <div className="flex flex-col gap-1.5">
        {skipLocked && (
          <p className="text-xs font-medium text-amber-400 animate-pulse">Volgende nummer wordt geladen…</p>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={() => { if (!skipLocked) getSocket().emit("track:skip", { token: getRadioToken() }); }}
            disabled={skipLocked}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
              skipLocked
                ? "border-gray-700 bg-gray-800/50 text-gray-600 cursor-not-allowed"
                : "border-gray-700 bg-gray-800 text-gray-300 hover:border-violet-500 hover:text-white"
            }`}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            Skip
          </button>
        </div>
      </div>
    );
  }

  if (mode === "jukebox") {
    return (
      <div className="flex flex-col gap-1.5">
        {skipLocked && (
          <p className="text-xs font-medium text-amber-400 animate-pulse">Volgende nummer wordt geladen…</p>
        )}
        <div className="flex items-center gap-2">
          {anyoneCanSkip && (
            <button
              onClick={handleAnyoneSkip}
              disabled={skipLocked}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                skipLocked
                  ? "border-gray-700 bg-gray-800/50 text-gray-600 cursor-not-allowed"
                  : "border-orange-500/30 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20"
              }`}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              Skip
            </button>
          )}
          {admin && (
            <button
              onClick={handleAdminSkip}
              disabled={skipLocked}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                skipLocked
                  ? "bg-gray-800/50 text-gray-600 cursor-not-allowed"
                  : "bg-red-600/20 text-red-400 hover:bg-red-600/30"
              }`}
            >
              Skip (admin)
            </button>
          )}
        </div>
        {isLongTrack && !anyoneCanSkip && timeUntilSkip > 0 && (
          <p className="text-xs text-gray-500">
            Iedereen kan skippen over {Math.floor(timeUntilSkip / 60)}:{String(timeUntilSkip % 60).padStart(2, "0")}
          </p>
        )}
      </div>
    );
  }

  // DJ / Radio
  return (
    <div className="flex flex-col gap-1.5">
      {skipLocked && (
        <p className="text-xs font-medium text-amber-400 animate-pulse">Volgende nummer wordt geladen…</p>
      )}
      <div className="flex items-center gap-2">
        {anyoneCanSkip && (
          <button
            onClick={handleAnyoneSkip}
            disabled={skipLocked}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
              skipLocked
                ? "border-gray-700 bg-gray-800/50 text-gray-600 cursor-not-allowed"
                : "border-orange-500/30 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20"
            }`}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            Skip
          </button>
        )}
        {admin && (
          <button
            onClick={handleAdminSkip}
            disabled={skipLocked}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
              skipLocked
                ? "bg-gray-800/50 text-gray-600 cursor-not-allowed"
                : "bg-red-600/20 text-red-400 hover:bg-red-600/30"
            }`}
          >
            Skip (admin)
          </button>
        )}
      </div>
      {isLongTrack && !anyoneCanSkip && timeUntilSkip > 0 && !admin && (
        <p className="text-xs text-gray-500">
          Iedereen kan skippen over {Math.floor(timeUntilSkip / 60)}:{String(timeUntilSkip % 60).padStart(2, "0")}
        </p>
      )}
    </div>
  );
}
