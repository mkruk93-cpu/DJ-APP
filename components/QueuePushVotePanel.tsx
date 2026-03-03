"use client";

import { useEffect, useState } from "react";
import { useRadioStore } from "@/lib/radioStore";
import { getSocket } from "@/lib/socket";

export default function QueuePushVotePanel() {
  const vote = useRadioStore((s) => s.queuePushVote);
  const locked = useRadioStore((s) => s.queuePushLocked);
  const [timeLeft, setTimeLeft] = useState(0);
  const [showLockHint, setShowLockHint] = useState(false);
  const [optimisticVoted, setOptimisticVoted] = useState(false);
  const [dismissedVoteId, setDismissedVoteId] = useState<string | null>(null);
  const [dismissedLockHint, setDismissedLockHint] = useState(false);

  useEffect(() => {
    if (!vote) {
      setTimeLeft(0);
      setOptimisticVoted(false);
      return;
    }
    const expiresAt = vote.expires_at;
    function tick() {
      setTimeLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    }
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [vote]);

  useEffect(() => {
    if (!vote) {
      setOptimisticVoted(false);
      return;
    }
    // Sync optimistic state with server-confirmed vote state.
    setOptimisticVoted((prev) => prev || vote.voted);
  }, [vote?.id, vote?.voted, vote]);

  useEffect(() => {
    if (!locked || vote) {
      setShowLockHint(false);
      setDismissedLockHint(false);
      return;
    }
    setShowLockHint(true);
    const timer = setTimeout(() => setShowLockHint(false), 3200);
    return () => clearTimeout(timer);
  }, [locked, vote]);

  useEffect(() => {
    if (!vote) {
      setDismissedVoteId(null);
      return;
    }
    if (dismissedVoteId && dismissedVoteId !== vote.id) {
      setDismissedVoteId(null);
    }
  }, [vote?.id, vote, dismissedVoteId]);

  const voteVisible = !!vote && dismissedVoteId !== vote.id;
  const lockVisible = showLockHint && locked && !vote && !dismissedLockHint;

  if (!voteVisible && !lockVisible) return null;

  const hasVoted = optimisticVoted || !!vote?.voted;

  return (
    <div className="relative overflow-hidden rounded-xl border border-gray-800 bg-gray-900 px-3 py-2 shadow-lg shadow-violet-500/5">
      <button
        type="button"
        onClick={() => {
          if (voteVisible && vote) {
            setDismissedVoteId(vote.id);
            return;
          }
          setDismissedLockHint(true);
        }}
        className="absolute right-2 top-2 rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400 transition hover:border-gray-600 hover:text-gray-200"
        aria-label="Verberg push-stemming"
        title="Verberg"
      >
        Verberg
      </button>

      {lockVisible && (
        <p className="pr-16 text-xs text-amber-300">
          Push tijdelijk vergrendeld. Wacht tot het volgende nummer uit de wachtrij start.
        </p>
      )}

      {voteVisible && vote && (
        <div className="space-y-2">
          <div className="flex min-w-0 items-center gap-2 pr-16">
            {vote.thumbnail ? (
              <img src={vote.thumbnail} alt="" className="h-10 w-10 rounded object-cover" />
            ) : (
              <div className="h-10 w-10 rounded bg-gray-800" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white">{vote.title ?? "Onbekend nummer"}</p>
              <p className="truncate text-[11px] text-gray-400">
                Voorstel van <span className="text-violet-300">{vote.proposed_by}</span> · door{" "}
                <span className="text-violet-300">{vote.added_by}</span>
              </p>
              <p className="text-[11px] text-gray-500">
                Nodig: {vote.required} ja - nog {timeLeft}s
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              disabled={hasVoted}
              onClick={() => {
                setOptimisticVoted(true);
                getSocket().emit("queuePushVote:cast", { vote: "yes" });
              }}
              className="rounded-md bg-violet-600 px-3 py-1.5 font-semibold text-white transition hover:bg-violet-500 disabled:cursor-default disabled:opacity-50"
            >
              Ja, geef voorrang ({vote.yes})
            </button>
            <button
              type="button"
              disabled={hasVoted}
              onClick={() => {
                setOptimisticVoted(true);
                getSocket().emit("queuePushVote:cast", { vote: "no" });
              }}
              className="rounded-md border border-gray-700 px-3 py-1.5 font-semibold text-gray-200 transition hover:border-gray-600 disabled:cursor-default disabled:opacity-50"
            >
              Nee, laat wachtrij staan ({vote.no})
            </button>
            {hasVoted && <span className="text-violet-300">Jouw stem is meegeteld</span>}
          </div>
        </div>
      )}
    </div>
  );
}
