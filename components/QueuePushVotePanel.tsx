"use client";

import { useEffect, useState } from "react";
import { useRadioStore } from "@/lib/radioStore";
import { getSocket } from "@/lib/socket";

export default function QueuePushVotePanel() {
  const vote = useRadioStore((s) => s.queuePushVote);
  const locked = useRadioStore((s) => s.queuePushLocked);
  const [timeLeft, setTimeLeft] = useState(0);
  const [showLockHint, setShowLockHint] = useState(false);

  useEffect(() => {
    if (!vote) {
      setTimeLeft(0);
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
    if (!locked || vote) {
      setShowLockHint(false);
      return;
    }
    setShowLockHint(true);
    const timer = setTimeout(() => setShowLockHint(false), 3200);
    return () => clearTimeout(timer);
  }, [locked, vote]);

  if (!vote && !locked) return null;

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 px-3 py-2 shadow-lg shadow-violet-500/5">
      {showLockHint && locked && !vote && (
        <p className="text-xs text-amber-300">
          Push tijdelijk vergrendeld. Wacht tot het volgende nummer uit de wachtrij start.
        </p>
      )}

      {vote && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
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
                Nodig: {vote.required} ja · timer: {timeLeft}s
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              disabled={vote.voted}
              onClick={() => getSocket().emit("queuePushVote:cast", { vote: "yes" })}
              className="rounded-md bg-violet-600 px-3 py-1.5 font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50"
            >
              Ja ({vote.yes})
            </button>
            <button
              type="button"
              disabled={vote.voted}
              onClick={() => getSocket().emit("queuePushVote:cast", { vote: "no" })}
              className="rounded-md border border-gray-700 px-3 py-1.5 font-semibold text-gray-200 transition hover:border-gray-600 disabled:opacity-50"
            >
              Nee ({vote.no})
            </button>
            {vote.voted && <span className="text-gray-400">Je hebt al gestemd</span>}
          </div>
        </div>
      )}
    </div>
  );
}
