"use client";

import { useRadioStore } from "@/lib/radioStore";
import { getSocket } from "@/lib/socket";
import { getRadioToken, isRadioAdmin } from "@/lib/auth";

export default function SkipButton() {
  const mode = useRadioStore((s) => s.mode);
  const voteState = useRadioStore((s) => s.voteState);
  const currentTrack = useRadioStore((s) => s.currentTrack);
  const admin = isRadioAdmin();

  if (!currentTrack) return null;

  function handleAdminSkip() {
    getSocket().emit("track:skip", { isAdmin: true, token: getRadioToken() });
  }

  function handleVoteSkip() {
    getSocket().emit("vote:skip", {});
  }

  // Democracy: everyone can vote skip, admin can force skip
  if (mode === "democracy") {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={handleVoteSkip}
          className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm font-medium text-gray-300 transition hover:border-violet-500 hover:text-white"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 11l5-5m0 0l5 5m-5-5v12" />
          </svg>
          Stem skip
          {voteState && (
            <span className="ml-1 rounded-full bg-violet-500/20 px-2 py-0.5 text-xs font-semibold text-violet-400">
              {voteState.votes}/{voteState.required}
            </span>
          )}
        </button>
        {admin && (
          <button
            onClick={handleAdminSkip}
            className="rounded-lg bg-red-600/20 px-3 py-2 text-sm font-medium text-red-400 transition hover:bg-red-600/30"
          >
            Skip (admin)
          </button>
        )}
      </div>
    );
  }

  // Party: everyone can skip directly
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

  // Jukebox: admin can skip, others see a vote skip button
  if (mode === "jukebox") {
    return (
      <div className="flex items-center gap-2">
        {admin && (
          <button
            onClick={handleAdminSkip}
            className="rounded-lg bg-red-600/20 px-3 py-2 text-sm font-medium text-red-400 transition hover:bg-red-600/30"
          >
            Skip (admin)
          </button>
        )}
      </div>
    );
  }

  // DJ / Radio: only admin can skip
  if (admin) {
    return (
      <button
        onClick={handleAdminSkip}
        className="rounded-lg bg-red-600/20 px-3 py-2 text-sm font-medium text-red-400 transition hover:bg-red-600/30"
      >
        Skip (admin)
      </button>
    );
  }

  return null;
}
