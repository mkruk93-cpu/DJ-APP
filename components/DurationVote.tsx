"use client";

import { useEffect, useState } from "react";
import { useRadioStore } from "@/lib/radioStore";
import { getSocket } from "@/lib/socket";

export default function DurationVote() {
  const vote = useRadioStore((s) => s.durationVote);
  const [timeLeft, setTimeLeft] = useState(0);
  const [result, setResult] = useState<{ accepted: boolean; title: string | null } | null>(null);

  useEffect(() => {
    const socket = getSocket();

    function onResult(data: { accepted: boolean; title: string | null }) {
      setResult(data);
      setTimeout(() => setResult(null), 4000);
    }

    socket.on("durationVote:result", onResult);
    return () => { socket.off("durationVote:result", onResult); };
  }, []);

  useEffect(() => {
    if (!vote) { setTimeLeft(0); return; }

    function tick() {
      if (!vote) return;
      const left = Math.max(0, Math.ceil((vote.expires_at - Date.now()) / 1000));
      setTimeLeft(left);
    }

    tick();
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, [vote]);

  if (result) {
    return (
      <div className={`rounded-xl border p-4 text-center ${
        result.accepted
          ? "border-green-500/30 bg-green-500/10"
          : "border-red-500/30 bg-red-500/10"
      }`}>
        <p className={`text-sm font-semibold ${result.accepted ? "text-green-400" : "text-red-400"}`}>
          {result.accepted
            ? `"${result.title ?? "Nummer"}" is goedgekeurd!`
            : `"${result.title ?? "Nummer"}" is geweigerd.`}
        </p>
      </div>
    );
  }

  if (!vote) return null;

  const mins = Math.floor(vote.duration / 60);
  const secs = String(Math.round(vote.duration % 60)).padStart(2, "0");
  const total = vote.yes + vote.no;

  return (
    <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-3">
      <div className="flex items-start gap-3">
        {vote.thumbnail && (
          <img
            src={vote.thumbnail}
            alt=""
            className="h-14 w-20 shrink-0 rounded-lg object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-yellow-500">
            Stemming — Nummer langer dan 5 min
          </p>
          <p className="truncate text-sm font-medium text-white">
            {vote.title ?? "Onbekend nummer"}
          </p>
          <p className="text-xs text-gray-400">
            {mins}:{secs} — aangevraagd door {vote.added_by}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <span className="text-2xl font-bold text-yellow-400 tabular-nums">{timeLeft}s</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 rounded-full bg-gray-700 overflow-hidden">
          {total > 0 && (
            <div
              className="h-full bg-green-500 transition-all duration-300"
              style={{ width: `${(vote.yes / total) * 100}%` }}
            />
          )}
        </div>
        <span className="text-xs text-gray-400 tabular-nums">
          {vote.yes} ja / {vote.no} nee
        </span>
      </div>

      {!vote.voted ? (
        <div className="flex gap-2">
          <button
            onClick={() => getSocket().emit("durationVote:cast", { vote: "yes" })}
            className="flex-1 rounded-lg bg-green-600/20 py-2.5 text-sm font-semibold text-green-400 transition hover:bg-green-600/30"
          >
            Ja, toevoegen
          </button>
          <button
            onClick={() => getSocket().emit("durationVote:cast", { vote: "no" })}
            className="flex-1 rounded-lg bg-red-600/20 py-2.5 text-sm font-semibold text-red-400 transition hover:bg-red-600/30"
          >
            Nee, te lang
          </button>
        </div>
      ) : (
        <p className="text-center text-xs text-gray-500">Je hebt al gestemd</p>
      )}
    </div>
  );
}
