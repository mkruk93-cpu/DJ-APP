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
  const [votedOption, setVotedOption] = useState<number | null>(null);
  const [dismissedPollId, setDismissedPollId] = useState<string | null>(null);
  const [lastRefreshTs, setLastRefreshTs] = useState<number>(Date.now());

  const canVote = useMemo(() => Boolean(poll && poll.options.length >= 2), [poll]);
  const pollStorageKey = useMemo(
    () => (poll ? `live_poll_vote:${poll.id}:${getNickname().toLowerCase()}` : null),
    [poll?.id],
  );

  async function refresh() {
    try {
      const res = await fetch("/api/live-polls", { cache: "no-store" });
      const data = await res.json();
      setPoll(data?.poll ?? null);
      setLastRefreshTs(Date.now());
    } catch {
      setPoll(null);
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedDismissed = window.localStorage.getItem("live_poll_dismissed_id");
    if (storedDismissed) setDismissedPollId(storedDismissed);
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!poll || !pollStorageKey || typeof window === "undefined") return;
    const storedVote = window.localStorage.getItem(pollStorageKey);
    const parsedVote = Number(storedVote);
    setVotedOption(Number.isInteger(parsedVote) && parsedVote >= 0 ? parsedVote : null);
    if (dismissedPollId && dismissedPollId !== poll.id) {
      setDismissedPollId(null);
      window.localStorage.removeItem("live_poll_dismissed_id");
    }
  }, [poll?.id, pollStorageKey, dismissedPollId]);

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
        setVotedOption(optionIndex);
        if (pollStorageKey && typeof window !== "undefined") {
          window.localStorage.setItem(pollStorageKey, String(optionIndex));
        }
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
  if (dismissedPollId === poll.id) return null;

  const isResultsMode = votedOption !== null;

  function dismissPollCard(pollId: string) {
    setDismissedPollId(pollId);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("live_poll_dismissed_id", pollId);
    }
  }

  return (
    <section className="fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+4.35rem)] z-[150] mx-auto w-auto max-w-xl rounded-2xl border border-fuchsia-500/35 bg-[#1a1024]/90 p-3 shadow-xl shadow-fuchsia-900/30 backdrop-blur sm:static sm:inset-auto sm:bottom-auto sm:mx-0 sm:max-w-none sm:p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-fuchsia-200">
          Live Poll
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-fuchsia-300/90">{poll.totalVotes} stemmen</span>
          <button
            type="button"
              onClick={() => dismissPollCard(poll.id)}
            className="rounded border border-fuchsia-400/35 bg-fuchsia-900/25 px-2 py-0.5 text-[11px] text-fuchsia-100 transition hover:bg-fuchsia-800/35"
            aria-label="Verberg live poll"
          >
            Sluiten
          </button>
        </div>
      </div>
      <p className="mb-2 text-sm font-medium text-white">{poll.question}</p>
      <div className="max-h-[46dvh] space-y-2 overflow-y-auto pr-1 sm:max-h-none">
        {poll.options.map((opt, idx) => {
          const count = poll.counts[idx] ?? 0;
          const pct = poll.totalVotes > 0 ? Math.round((count / poll.totalVotes) * 100) : 0;
          const isOwnVote = votedOption === idx;
          if (isResultsMode) {
            return (
              <div
                key={`${opt}-${idx}`}
                className={`relative w-full overflow-hidden rounded-lg border px-3 py-2 ${
                  isOwnVote ? "border-violet-400/60 bg-violet-500/15" : "border-fuchsia-400/30 bg-white/5"
                }`}
              >
                <span
                  className="pointer-events-none absolute inset-y-0 left-0 bg-fuchsia-500/20 transition-all"
                  style={{ width: `${pct}%` }}
                />
                <span className="relative z-10 flex items-center justify-between gap-3">
                  <span className="text-sm text-fuchsia-50">
                    {opt}
                    {isOwnVote ? " • jouw stem" : ""}
                  </span>
                  <span className="text-xs text-fuchsia-200/90">{count} ({pct}%)</span>
                </span>
              </div>
            );
          }
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
      {isResultsMode ? (
        <p className="mt-2 text-[11px] text-fuchsia-200/95">
          Live tussenstand (auto refresh) · bijgewerkt {Math.max(0, Math.round((Date.now() - lastRefreshTs) / 1000))}s geleden
        </p>
      ) : null}
      {feedback ? <p className="mt-2 text-xs text-fuchsia-200">{feedback}</p> : null}
    </section>
  );
}
