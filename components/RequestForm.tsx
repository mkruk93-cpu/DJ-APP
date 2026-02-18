"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { getSupabase } from "@/lib/supabaseClient";

interface Request {
  id: string;
  nickname: string;
  url: string;
  title: string | null;
  artist: string | null;
  thumbnail: string | null;
  status: string;
  created_at: string;
}

const URL_REGEX = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|soundcloud\.com)\/.+$/i;
const MAX_QUEUE = 3;
const COOLDOWN_SEC = 20;
const MAX_DURATION_SEC = 15 * 60;

const statusConfig: Record<string, { label: string; color: string }> = {
  pending: { label: "Wachtrij", color: "bg-yellow-500/20 text-yellow-400" },
  approved: { label: "Goedgekeurd", color: "bg-green-500/20 text-green-400" },
  downloaded: { label: "Gedownload", color: "bg-violet-500/20 text-violet-400" },
  rejected: { label: "Afgekeurd", color: "bg-red-500/20 text-red-400" },
  error: { label: "Download mislukt", color: "bg-orange-500/20 text-orange-400" },
};

export default function RequestForm() {
  const [url, setUrl] = useState("");
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);
  const [allRequests, setAllRequests] = useState<Request[]>([]);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const nickname = typeof window !== "undefined" ? localStorage.getItem("nickname") ?? "anon" : "anon";

  const myActiveRequests = allRequests.filter(
    (r) => r.nickname === nickname && (r.status === "pending" || r.status === "approved")
  );

  const load = useCallback(async () => {
    const { data } = await getSupabase()
      .from("requests")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setAllRequests(data);
  }, []);

  useEffect(() => {
    const sb = getSupabase();
    load();

    const channel = sb
      .channel("all-requests")
      .on<Request>(
        "postgres_changes",
        { event: "*", schema: "public", table: "requests" },
        () => { load(); }
      )
      .subscribe();

    return () => { sb.removeChannel(channel); };
  }, [load]);

  useEffect(() => {
    if (cooldownLeft <= 0) return;
    cooldownTimer.current = setInterval(() => {
      setCooldownLeft((prev) => {
        if (prev <= 1) {
          if (cooldownTimer.current) clearInterval(cooldownTimer.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => { if (cooldownTimer.current) clearInterval(cooldownTimer.current); };
  }, [cooldownLeft > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();

    if (cooldownLeft > 0) {
      setFeedback({ msg: `Even geduld — wacht nog ${cooldownLeft}s.`, ok: false });
      return;
    }

    if (!URL_REGEX.test(trimmed)) {
      setFeedback({ msg: "Ongeldige URL — gebruik een YouTube of SoundCloud link.", ok: false });
      return;
    }

    setSubmitting(true);
    const sb = getSupabase();

    let meta = { title: null as string | null, artist: null as string | null, thumbnail: null as string | null, duration_seconds: null as number | null };
    try {
      const res = await fetch(`/api/metadata?url=${encodeURIComponent(trimmed)}`);
      if (res.ok) meta = await res.json();
    } catch { /* proceed without metadata */ }

    if (meta.duration_seconds && meta.duration_seconds > MAX_DURATION_SEC) {
      const mins = Math.ceil(meta.duration_seconds / 60);
      setSubmitting(false);
      setFeedback({ msg: `Dit nummer is ${mins} minuten — maximaal 15 minuten toegestaan.`, ok: false });
      return;
    }

    if (myActiveRequests.length >= MAX_QUEUE) {
      const oldest = [...myActiveRequests].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      )[0];
      if (oldest) {
        await sb.from("requests").delete().eq("id", oldest.id);
      }
    }

    let initialStatus = "pending";
    const { data: settings } = await sb
      .from("settings")
      .select("auto_approve")
      .eq("id", 1)
      .single();
    if (settings?.auto_approve) initialStatus = "approved";

    const { error } = await sb.from("requests").insert({
      nickname,
      url: trimmed,
      title: meta.title,
      artist: meta.artist,
      thumbnail: meta.thumbnail,
      status: initialStatus,
    });

    setSubmitting(false);

    if (error) {
      setFeedback({ msg: "Er ging iets mis. Probeer opnieuw.", ok: false });
      return;
    }

    setUrl("");
    setCooldownLeft(COOLDOWN_SEC);
    setFeedback({ msg: "Verzoekje ingediend!", ok: true });
    setTimeout(() => setFeedback(null), 3000);
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5">
      <div className="border-b border-gray-800 px-3 py-2 sm:px-4 sm:py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-violet-400 sm:text-sm">
          Verzoekjes
        </h2>
      </div>

      <form onSubmit={handleSubmit} className="space-y-1.5 border-b border-gray-800 px-2 py-2 sm:space-y-2 sm:px-4 sm:py-3">
        <input
          type="url"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setFeedback(null); }}
          placeholder="YouTube / SoundCloud URL"
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-white placeholder-gray-500 outline-none transition focus:border-violet-500 sm:px-3 sm:py-2 sm:text-sm"
        />
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-500 active:scale-[0.98] disabled:opacity-40 sm:px-4 sm:py-2 sm:text-sm"
        >
          {submitting ? "Laden..." : "Insturen"}
        </button>
        {feedback && (
          <p className={`text-xs sm:text-sm ${feedback.ok ? "text-green-400" : "text-red-400"}`}>
            {feedback.msg}
          </p>
        )}
      </form>

      <div className="chat-scroll flex-1 space-y-1.5 overflow-y-auto px-2 py-2 sm:space-y-2 sm:px-4 sm:py-3">
        {allRequests.length === 0 && (
          <p className="text-center text-xs text-gray-500 sm:text-sm">Nog geen verzoekjes</p>
        )}
        {allRequests.map((r) => {
          const cfg = statusConfig[r.status] ?? { label: r.status, color: "" };
          const isOwn = r.nickname === nickname;
          return (
            <div
              key={r.id}
              className={`overflow-hidden rounded-lg border transition ${
                r.status === "rejected"
                  ? "border-red-500/20 bg-red-500/5 opacity-60"
                  : r.status === "error"
                    ? "border-orange-500/20 bg-orange-500/5 opacity-70"
                    : isOwn
                      ? "border-violet-500/20 bg-violet-500/5"
                      : "border-gray-800 bg-gray-800/50"
              }`}
            >
              <div className="flex gap-2 p-2 sm:gap-3 sm:p-3">
                {r.thumbnail && (
                  <img
                    src={r.thumbnail}
                    alt=""
                    className="hidden h-14 w-20 shrink-0 rounded-md object-cover sm:block"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex flex-wrap items-center gap-1 sm:mb-1 sm:gap-1.5">
                    <span className="text-[10px] font-semibold text-violet-400 sm:text-xs">
                      {r.nickname}
                    </span>
                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium sm:px-2 sm:text-xs ${cfg.color}`}>
                      {cfg.label}
                    </span>
                  </div>
                  {r.title ? (
                    <p className="truncate text-xs font-medium text-white sm:text-sm">{r.title}</p>
                  ) : (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-xs text-violet-400 underline decoration-violet-400/30 hover:decoration-violet-400 sm:text-sm"
                    >
                      {r.url}
                    </a>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
