"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { getSocket } from "@/lib/socket";
import { useRadioStore } from "@/lib/radioStore";
import { canPerformAction } from "@/lib/types";
import { isRadioAdmin, getRadioToken } from "@/lib/auth";

const YT_URL_REGEX =
  /^https?:\/\/(www\.)?(youtube\.com\/(watch\?.*v=|shorts\/|embed\/)|youtu\.be\/)[\w-]+/i;

interface SearchResult {
  id: string;
  title: string;
  url: string;
  duration: number | null;
  thumbnail: string;
  channel: string;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function QueueAdd() {
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const mode = useRadioStore((s) => s.mode);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const serverUrl = useRadioStore((s) => s.serverUrl) ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL;
  const canAdd = canPerformAction(mode, "add_to_queue", isRadioAdmin());
  const isUrl = YT_URL_REGEX.test(input.trim());

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const search = useCallback((query: string) => {
    if (!serverUrl || query.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    fetch(`${serverUrl}/search?q=${encodeURIComponent(query)}`)
      .then((r) => r.json())
      .then((data: SearchResult[]) => {
        setResults(data);
        setShowResults(data.length > 0);
      })
      .catch(() => setResults([]))
      .finally(() => setSearching(false));
  }, [serverUrl]);

  if (!canAdd) return null;

  function handleInputChange(value: string) {
    setInput(value);
    setFeedback(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (YT_URL_REGEX.test(value.trim())) {
      setResults([]);
      setShowResults(false);
      return;
    }

    const query = value.trim();
    if (query.length >= 2) {
      debounceRef.current = setTimeout(() => search(query), 300);
    } else {
      setResults([]);
      setShowResults(false);
    }
  }

  function showFeedback(msg: string, ok: boolean) {
    setFeedback({ msg, ok });
    setSubmitting(false);
    setTimeout(() => setFeedback(null), 5000);
  }

  function submitUrl(youtubeUrl: string) {
    setSubmitting(true);
    setFeedback({ msg: "Even checken...", ok: true });
    setShowResults(false);

    const nickname =
      typeof window !== "undefined"
        ? localStorage.getItem("nickname") ?? "anonymous"
        : "anonymous";

    const socket = getSocket();

    function onError(data: { message: string }) {
      showFeedback(data.message, false);
      setInput("");
      cleanup();
    }

    function onInfo(data: { message: string }) {
      setFeedback({ msg: data.message, ok: true });
    }

    function onQueueUpdate() {
      showFeedback("Toegevoegd aan de wachtrij!", true);
      setInput("");
      cleanup();
    }

    function cleanup() {
      socket.off("error:toast", onError);
      socket.off("info:toast", onInfo);
      socket.off("queue:update", onQueueUpdate);
    }

    socket.on("error:toast", onError);
    socket.on("info:toast", onInfo);
    socket.on("queue:update", onQueueUpdate);

    socket.emit("queue:add", { youtube_url: youtubeUrl, added_by: nickname, token: getRadioToken() });

    setTimeout(() => {
      if (submitting) {
        cleanup();
        setSubmitting(false);
      }
    }, 30_000);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();

    if (!YT_URL_REGEX.test(trimmed)) {
      if (results.length > 0) {
        selectResult(results[0]);
      } else {
        setFeedback({ msg: "Plak een YouTube link of zoek een nummer.", ok: false });
      }
      return;
    }

    submitUrl(trimmed);
  }

  function selectResult(result: SearchResult) {
    setInput(result.title);
    setResults([]);
    setShowResults(false);
    submitUrl(result.url);
  }

  return (
    <div ref={wrapperRef} className="relative">
      <form onSubmit={handleSubmit} className="space-y-2 rounded-xl border border-gray-800 bg-gray-900 p-3 shadow-lg shadow-violet-500/5 sm:p-4">
        <label className="block text-xs font-semibold uppercase tracking-wider text-violet-400">
          Nummer toevoegen
        </label>
        <div className="relative">
          <input
            type="text"
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onFocus={() => { if (results.length > 0) setShowResults(true); }}
            placeholder="Zoek op YouTube of plak een link..."
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none transition focus:border-violet-500"
          />
          {searching && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <span className="block h-4 w-4 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
            </div>
          )}
        </div>
        <button
          type="submit"
          disabled={submitting || !input.trim()}
          className="w-full rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-500 active:scale-[0.98] disabled:opacity-40"
        >
          {submitting ? "Checken..." : isUrl ? "Toevoegen" : "Zoeken"}
        </button>
        {feedback && (
          <p className={`text-sm ${feedback.ok ? "text-green-400" : "text-red-400"}`}>
            {feedback.msg}
          </p>
        )}
      </form>

      {/* Search results dropdown */}
      {showResults && results.length > 0 && (
        <div className="absolute left-0 right-0 z-50 mt-1 max-h-80 overflow-y-auto rounded-xl border border-gray-700 bg-gray-900 shadow-2xl shadow-black/50">
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => selectResult(r)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-gray-800/80 first:rounded-t-xl last:rounded-b-xl"
            >
              <img
                src={r.thumbnail}
                alt=""
                className="h-12 w-16 shrink-0 rounded-md object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">{r.title}</p>
                <div className="flex items-center gap-2">
                  {r.channel && (
                    <span className="truncate text-xs text-gray-400">{r.channel}</span>
                  )}
                  {r.duration !== null && (
                    <span className="shrink-0 text-xs tabular-nums text-gray-500">
                      {formatDuration(r.duration)}
                    </span>
                  )}
                </div>
              </div>
              {r.duration !== null && r.duration > 3900 && (
                <span className="shrink-0 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-red-400">
                  Te lang
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
