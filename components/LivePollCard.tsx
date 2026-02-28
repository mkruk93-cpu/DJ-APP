"use client";

import { useEffect, useMemo, useState } from "react";

type Poll = {
  id: string;
  question: string;
  options: string[];
  counts: number[];
  totalVotes: number;
};

function getNickname(): string {
  if (typeof window === "undefined") return "Listener";
  const fromStore =
    window.localStorage.getItem("radio_nickname") ??
    window.localStorage.getItem("dj_radio_nickname") ??
    "";
  const trimmed = fromStore.trim();
  return trimmed || "Listener";
}

export default function LivePollCard() {
  const [poll, setPoll] = useState<Poll | null>(null);
  const [submitting, setSubmitting] = useState<number | null>(null);
  const [feedback, setFeedback] = useState("");

  const canVote = useMemo(() => Boolean(poll && poll.options.length >= 2), [poll]);

  async function refresh() {
    try {
      const res = await fetch("/api/live-polls", { cache: "no-store" });
      const data = await res.json();
      setPoll(data?.poll ?? null);
    } catch {
      setPoll(null);
    }
  }

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(t);
  }, []);

  async function vote(optionIndex: number) {
    if (!poll) return;
    setSubmitting(optionIndex);
    setFeedback("");
    try {
      const res = await fetch("/api/live-polls/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pollId: poll.id,
          optionIndex,
          nickname: getNickname(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback(data?.error ?? "Stemmen mislukt");
      } else {
        setFeedback("Je stem is meegeteld");
        await refresh();
      }
    } catch {
      setFeedback("Verbinding mislukt");
    } finally {
      setSubmitting(null);
    }
  }

  if (!poll) return null;

  return (
    <section className="rounded-2xl border border-fuchsia-500/35 bg-[#1a1024]/70 p-4 backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-fuchsia-200">
          Live Poll
        </h3>
        <span className="text-xs text-fuchsia-300/90">{poll.totalVotes} stemmen</span>
      </div>
      <p className="mb-3 text-sm font-medium text-white">{poll.question}</p>
      <div className="space-y-2">
        {poll.options.map((opt, idx) => {
          const count = poll.counts[idx] ?? 0;
          const pct = poll.totalVotes > 0 ? Math.round((count / poll.totalVotes) * 100) : 0;
          return (
            <button
              key={`${opt}-${idx}`}
              type="button"
              onClick={() => void vote(idx)}
              disabled={!canVote || submitting !== null}
              className="group relative w-full overflow-hidden rounded-lg border border-fuchsia-400/30 bg-white/5 px-3 py-2 text-left transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span
                className="pointer-events-none absolute inset-y-0 left-0 bg-fuchsia-500/20 transition-all"
                style={{ width: `${pct}%` }}
              />
              <span className="relative z-10 flex items-center justify-between gap-3">
                <span className="text-sm text-fuchsia-50">{opt}</span>
                <span className="text-xs text-fuchsia-200/90">{count}</span>
              </span>
            </button>
          );
        })}
      </div>
      {feedback ? <p className="mt-2 text-xs text-fuchsia-200">{feedback}</p> : null}
    </section>
  );
}
