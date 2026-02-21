"use client";

import { useState, useEffect } from "react";
import { useRadioStore } from "@/lib/radioStore";
import { getSocket } from "@/lib/socket";
import { getRadioToken, isRadioAdmin } from "@/lib/auth";

const ANYONE_SKIP_AFTER = 300;

export default function SkipButton() {
  const mode = useRadioStore((s) => s.mode);
  const voteState = useRadioStore((s) => s.voteState);
  const currentTrack = useRadioStore((s) => s.currentTrack);
  const listenerCount = useRadioStore((s) => s.listenerCount);
  const modeSettings = useRadioStore((s) => s.modeSettings);
  const [voted, setVoted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const admin = isRadioAdmin();

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
    getSocket().emit("track:skip", { isAdmin: true, token: getRadioToken() });
  }

  function handleVoteSkip() {
    getSocket().emit("vote:skip", {});
    setVoted(true);
  }

  function handleAnyoneSkip() {
    getSocket().emit("track:skip", { token: getRadioToken() });
  }

  const threshold = modeSettings.democracy_threshold;
  const needed = voteState?.required ?? Math.max(1, Math.ceil(listenerCount * threshold / 100));

  if (mode === "democracy") {
    const hasVotes = voteState && voteState.votes > 0;

    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <button
            onClick={handleVoteSkip}
            disabled={voted && !admin}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
              voted
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
                {voteState.votes}/{voteState.required}
              </span>
            )}
          </button>
          {anyoneCanSkip && (
            <button
              onClick={handleAnyoneSkip}
              className="flex items-center gap-1.5 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-sm font-medium text-orange-400 transition hover:bg-orange-500/20"
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
              className="rounded-lg bg-red-600/20 px-3 py-2 text-sm font-medium text-red-400 transition hover:bg-red-600/30"
            >
              Skip
            </button>
          )}
        </div>
        {hasVotes && (
          <p className="text-xs text-gray-500">
            {voteState.votes} van {voteState.required} stemmen nodig om te skippen
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
      <div className="flex items-center gap-2">
        <button
          onClick={() => getSocket().emit("track:skip", { token: getRadioToken() })}
          className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm font-medium text-gray-300 transition hover:border-violet-500 hover:text-white"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          Skip
        </button>
      </div>
    );
  }

  if (mode === "jukebox") {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          {anyoneCanSkip && (
            <button
              onClick={handleAnyoneSkip}
              className="flex items-center gap-1.5 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-sm font-medium text-orange-400 transition hover:bg-orange-500/20"
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
              className="rounded-lg bg-red-600/20 px-3 py-2 text-sm font-medium text-red-400 transition hover:bg-red-600/30"
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
      <div className="flex items-center gap-2">
        {anyoneCanSkip && (
          <button
            onClick={handleAnyoneSkip}
            className="flex items-center gap-1.5 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-sm font-medium text-orange-400 transition hover:bg-orange-500/20"
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
            className="rounded-lg bg-red-600/20 px-3 py-2 text-sm font-medium text-red-400 transition hover:bg-red-600/30"
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
