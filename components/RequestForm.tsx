"use client";

import { useEffect, useState, useRef, useCallback, useId } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import { useRadioStore } from "@/lib/radioStore";
import { isSpotifyConfigured } from "@/lib/spotify";
import { getGenres, getGenreHits, type GenreOption, type GenreHit } from "@/lib/radioApi";
import SpotifyBrowser from "@/components/SpotifyBrowser";

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

type SearchSource = "youtube" | "soundcloud" | "spotify" | "genres";

interface SearchResult {
  id: string;
  title: string;
  url: string;
  duration: number | null;
  thumbnail: string;
  channel: string;
}

interface GenreHitRow extends GenreHit {
  query: string;
}

const URL_REGEX = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|soundcloud\.com)\/.+$/i;
const MAX_QUEUE = 3;
const COOLDOWN_SEC = 20;
const MAX_DURATION_SEC = 10 * 60;
const GENRE_PAGE_SIZE = 20;

const FALLBACK_GENRES: GenreOption[] = [
  "hardcore",
  "uptempo",
  "gabber",
  "hardstyle",
  "rawstyle",
  "frenchcore",
  "techno",
  "hard techno",
  "trance",
  "psytrance",
  "house",
  "tech house",
  "drum and bass",
  "edm",
  "dance",
  "hiphop",
  "nederlandse hiphop",
  "nederlands",
  "top 40",
  "pop",
].map((name) => ({ id: name, name }));

const statusConfig: Record<string, { label: string; color: string }> = {
  pending: { label: "Wachtrij", color: "bg-yellow-500/20 text-yellow-400" },
  approved: { label: "Goedgekeurd", color: "bg-green-500/20 text-green-400" },
  downloaded: { label: "Gedownload", color: "bg-violet-500/20 text-violet-400" },
  rejected: { label: "Afgekeurd", color: "bg-red-500/20 text-red-400" },
  error: { label: "Download mislukt", color: "bg-orange-500/20 text-orange-400" },
};

export default function RequestForm({ onNewRequest }: { onNewRequest?: () => void } = {}) {
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);
  const [allRequests, setAllRequests] = useState<Request[]>([]);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [source, setSource] = useState<SearchSource>("youtube");
  const [genreQuery, setGenreQuery] = useState("");
  const [genres, setGenres] = useState<GenreOption[]>([]);
  const [genresLoading, setGenresLoading] = useState(false);
  const [genreHits, setGenreHits] = useState<GenreHitRow[]>([]);
  const [genreHitsLoading, setGenreHitsLoading] = useState(false);
  const [genreHitsLoadingMore, setGenreHitsLoadingMore] = useState(false);
  const [genreHitsOffset, setGenreHitsOffset] = useState(0);
  const [genreHasMore, setGenreHasMore] = useState(false);
  const [activeGenre, setActiveGenre] = useState<string | null>(null);
  const [genreError, setGenreError] = useState<string | null>(null);
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const genreListRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const channelId = useId();
  const nickname = typeof window !== "undefined" ? localStorage.getItem("nickname") ?? "anon" : "anon";
  const serverUrl = useRadioStore((s) => s.serverUrl) ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL;

  const myActiveRequests = allRequests.filter(
    (r) => r.nickname === nickname && (r.status === "pending" || r.status === "approved")
  );

  const load = useCallback(async () => {
    const { data } = await getSupabase()
      .from("requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(15);
    if (data) setAllRequests(data);
  }, []);

  const search = useCallback((query: string) => {
    if (!serverUrl || query.length < 2 || (source !== "youtube" && source !== "soundcloud")) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    fetch(`${serverUrl}/search?q=${encodeURIComponent(query)}&source=${source}`)
      .then((r) => r.json())
      .then((data: SearchResult[]) => {
        setResults(data);
        setShowResults(data.length > 0);
      })
      .catch(() => setResults([]))
      .finally(() => setSearching(false));
  }, [serverUrl, source]);

  const loadGenres = useCallback((query: string) => {
    if (!serverUrl) {
      setGenres(FALLBACK_GENRES);
      setGenreError("Server niet bereikbaar, fallback genres geladen.");
      return;
    }
    setGenresLoading(true);
    setGenreError(null);
    Promise.resolve()
      .then(() => getGenres(query))
      .then((items) => {
        const normalized = items.filter((item): item is GenreOption => !!item?.id && !!item?.name);
        if (normalized.length > 0) {
          setGenres(normalized);
          return;
        }
        setGenres(FALLBACK_GENRES.filter((genre) =>
          genre.name.toLowerCase().includes(query.trim().toLowerCase()),
        ));
      })
      .catch(() => {
        const q = query.trim().toLowerCase();
        const fallback = q
          ? FALLBACK_GENRES.filter((genre) => genre.name.toLowerCase().includes(q))
          : FALLBACK_GENRES;
        setGenres(fallback);
        setGenreError("Kon genres niet laden van de server, fallback actief.");
      })
      .finally(() => setGenresLoading(false));
  }, [serverUrl]);

  const loadGenreHits = useCallback((genre: string, append = false) => {
    if (!serverUrl) return;
    const offset = append ? genreHitsOffset : 0;
    if (append) {
      setGenreHitsLoadingMore(true);
    } else {
      setGenreHitsLoading(true);
      setGenreHits([]);
      setGenreHitsOffset(0);
      setGenreHasMore(false);
    }
    setActiveGenre(genre);
    Promise.resolve()
      .then(() => getGenreHits(genre, GENRE_PAGE_SIZE, offset))
      .then((items) => {
        const normalized = items.filter(
          (item): item is GenreHit => !!item?.id && !!item?.title && !!item?.artist,
        );
        const mapped = normalized.map((item) => ({
          ...item,
          query: `${item.artist} - ${item.title}`,
        }));
        setGenreHits((prev) => {
          if (!append) return mapped;
          const merged = [...prev, ...mapped];
          return Array.from(
            new Map(merged.map((track) => [`${track.artist}-${track.title}`.toLowerCase(), track])).values(),
          );
        });
        setGenreHitsOffset(offset + GENRE_PAGE_SIZE);
        setGenreHasMore(mapped.length >= GENRE_PAGE_SIZE);
      })
      .catch(() => {
        if (!append) setGenreHits([]);
        setGenreHasMore(false);
      })
      .finally(() => {
        setGenreHitsLoading(false);
        setGenreHitsLoadingMore(false);
      });
  }, [serverUrl, genreHitsOffset]);

  useEffect(() => {
    const sb = getSupabase();
    load();

    const channel = sb
      .channel(`requests-${channelId}`)
      .on<Request>(
        "postgres_changes",
        { event: "*", schema: "public", table: "requests" },
        () => { load(); onNewRequest?.(); }
      )
      .subscribe();

    return () => { sb.removeChannel(channel); };
  }, [load]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

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

  useEffect(() => {
    if (source !== "genres") return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => loadGenres(genreQuery), 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [genreQuery, source, loadGenres]);

  useEffect(() => {
    if (source !== "genres" || !activeGenre) return;
    const genre = activeGenre;
    const root = genreListRef.current;
    const sentinel = loadMoreRef.current;
    if (!root || !sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        if (!visible) return;
        if (!genreHasMore || genreHitsLoading || genreHitsLoadingMore) return;
        loadGenreHits(genre, true);
      },
      { root, rootMargin: "120px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [source, activeGenre, genreHasMore, genreHitsLoading, genreHitsLoadingMore, loadGenreHits]);

  async function resolveToUrl(query: string, preferredSource: "youtube" | "soundcloud"): Promise<SearchResult | null> {
    if (!serverUrl) return null;
    try {
      const res = await fetch(`${serverUrl}/search?q=${encodeURIComponent(query)}&source=${preferredSource}`);
      if (!res.ok) return null;
      const data = await res.json() as SearchResult[];
      return data[0] ?? null;
    } catch {
      return null;
    }
  }

  async function submitRequest(rawInput: string, preferredSource: "youtube" | "soundcloud", providedThumb?: string) {
    const trimmed = rawInput.trim();

    if (cooldownLeft > 0) {
      setFeedback({ msg: `Even geduld — wacht nog ${cooldownLeft}s.`, ok: false });
      return;
    }

    setSubmitting(true);
    const sb = getSupabase();
    let finalUrl = trimmed;
    let finalThumb: string | null = providedThumb ?? null;

    if (!URL_REGEX.test(trimmed)) {
      const resolved = await resolveToUrl(trimmed, preferredSource);
      if (!resolved) {
        setSubmitting(false);
        setFeedback({ msg: `Geen resultaat gevonden voor "${trimmed}".`, ok: false });
        return;
      }
      finalUrl = resolved.url;
      finalThumb = finalThumb ?? resolved.thumbnail ?? null;
    }

    let meta = { title: null as string | null, artist: null as string | null, thumbnail: null as string | null, duration_seconds: null as number | null };
    try {
      const res = await fetch(`/api/metadata?url=${encodeURIComponent(finalUrl)}`);
      if (res.ok) meta = await res.json();
    } catch { /* proceed without metadata */ }

    if (meta.duration_seconds && meta.duration_seconds > MAX_DURATION_SEC) {
      const mins = Math.ceil(meta.duration_seconds / 60);
      setSubmitting(false);
      setFeedback({ msg: `Dit nummer is ${mins} minuten — maximaal 10 minuten toegestaan.`, ok: false });
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
      url: finalUrl,
      title: meta.title,
      artist: meta.artist,
      thumbnail: finalThumb ?? meta.thumbnail,
      status: initialStatus,
    });

    setSubmitting(false);

    if (error) {
      setFeedback({ msg: "Er ging iets mis. Probeer opnieuw.", ok: false });
      return;
    }

    setInput("");
    setResults([]);
    setShowResults(false);
    setCooldownLeft(COOLDOWN_SEC);
    setFeedback({ msg: "Verzoekje ingediend!", ok: true });
    setTimeout(() => setFeedback(null), 3000);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (source === "spotify" || source === "genres") return;
    const trimmed = input.trim();
    if (!trimmed) return;
    const preferredSource = source === "soundcloud" ? "soundcloud" : "youtube";
    await submitRequest(trimmed, preferredSource);
  }

  function handleInputChange(value: string) {
    setInput(value);
    setFeedback(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (URL_REGEX.test(value.trim()) || source === "spotify" || source === "genres") {
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

  async function selectResult(result: SearchResult) {
    setInput(result.title);
    setResults([]);
    setShowResults(false);
    const preferredSource = source === "soundcloud" ? "soundcloud" : "youtube";
    await submitRequest(result.url, preferredSource, result.thumbnail || undefined);
  }

  function switchSource(newSource: SearchSource) {
    setSource(newSource);
    setResults([]);
    setShowResults(false);
    setFeedback(null);
    if (newSource === "genres") {
      setInput("");
      setGenreHits([]);
      setGenreHitsOffset(0);
      setGenreHasMore(false);
      setActiveGenre(null);
      loadGenres(genreQuery);
      return;
    }
    if (newSource === "spotify") return;
    const query = input.trim();
    if (query.length >= 2 && !URL_REGEX.test(query)) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => search(query), 100);
    }
  }

  async function handleSpotifyAdd(searchQuery: string) {
    await submitRequest(searchQuery, "youtube");
  }

  return (
    <div ref={wrapperRef} className="flex h-full flex-col rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5">
      <div className="border-b border-gray-800 px-3 py-2 sm:px-4 sm:py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-violet-400 sm:text-sm">
          Verzoekjes
        </h2>
      </div>

      <form onSubmit={handleSubmit} className="space-y-2 border-b border-gray-800 px-3 py-2 sm:px-4 sm:py-3">
        <div className="flex gap-1 rounded-lg bg-gray-800 p-0.5">
          <button
            type="button"
            onClick={() => switchSource("youtube")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
              source === "youtube" ? "bg-red-500/20 text-red-400" : "text-gray-400 hover:text-gray-200"
            }`}
          >
            YouTube
          </button>
          <button
            type="button"
            onClick={() => switchSource("soundcloud")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
              source === "soundcloud" ? "bg-orange-500/20 text-orange-400" : "text-gray-400 hover:text-gray-200"
            }`}
          >
            SoundCloud
          </button>
          <button
            type="button"
            onClick={() => switchSource("genres")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
              source === "genres" ? "bg-fuchsia-500/20 text-fuchsia-300" : "text-gray-400 hover:text-gray-200"
            }`}
          >
            Genres
          </button>
          {isSpotifyConfigured() && (
            <button
              type="button"
              onClick={() => switchSource("spotify")}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                source === "spotify" ? "bg-[#1DB954]/20 text-[#1DB954]" : "text-gray-400 hover:text-gray-200"
              }`}
            >
              Spotify
            </button>
          )}
        </div>

        {source === "spotify" ? (
          <SpotifyBrowser onAddTrack={handleSpotifyAdd} submitting={submitting} />
        ) : source === "genres" ? (
          <div className="space-y-2">
            <input
              type="text"
              value={genreQuery}
              onChange={(e) => setGenreQuery(e.target.value)}
              placeholder="Zoek genre..."
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none transition focus:border-fuchsia-500"
            />
            <div className="flex gap-2 overflow-x-auto pb-1">
              {genres.map((genre) => (
                <button
                  key={genre.id}
                  type="button"
                  onClick={() => loadGenreHits(genre.name, false)}
                  className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                    activeGenre === genre.name
                      ? "border-fuchsia-400 bg-fuchsia-500/20 text-fuchsia-200"
                      : "border-gray-700 bg-gray-800 text-gray-300 hover:border-fuchsia-500/60 hover:text-white"
                  }`}
                >
                  {genre.name}
                </button>
              ))}
            </div>
            {genresLoading && <p className="text-xs text-gray-400">Genres laden...</p>}
            {genreError && <p className="text-xs text-amber-300">{genreError}</p>}
            {!genresLoading && genres.length === 0 && (
              <p className="text-xs text-gray-400">Geen genres gevonden.</p>
            )}

            <div ref={genreListRef} className="max-h-56 overflow-y-auto rounded-lg border border-gray-800 bg-gray-950/70">
              {genreHitsLoading ? (
                <p className="px-3 py-3 text-xs text-gray-400">Hitlijst laden...</p>
              ) : genreHits.length === 0 ? (
                <p className="px-3 py-3 text-xs text-gray-400">Kies een genre om tracks te tonen.</p>
              ) : (
                genreHits.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 border-b border-gray-800/80 px-3 py-2 last:border-b-0">
                    {item.thumbnail ? (
                      <img src={item.thumbnail} alt="" className="h-10 w-10 rounded object-cover" />
                    ) : (
                      <div className="h-10 w-10 rounded bg-gray-800" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-white">{item.title}</p>
                      <p className="truncate text-xs text-gray-400">{item.artist}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => submitRequest(item.query, "youtube", item.thumbnail || undefined)}
                      disabled={submitting}
                      className="rounded-md bg-violet-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50"
                    >
                      Verzoek
                    </button>
                  </div>
                ))
              )}
              {genreHitsLoadingMore && (
                <p className="px-3 py-2 text-xs text-gray-400">Meer tracks laden...</p>
              )}
              <div ref={loadMoreRef} className="h-1 w-full" />
            </div>
          </div>
        ) : (
          <>
            <div className="relative">
              <input
                type="text"
                value={input}
                onChange={(e) => handleInputChange(e.target.value)}
                onFocus={() => { if (results.length > 0) setShowResults(true); }}
                placeholder={source === "youtube" ? "Zoek op YouTube of plak een link..." : "Zoek op SoundCloud of plak een link..."}
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
              {submitting ? "Laden..." : "Insturen"}
            </button>
          </>
        )}
        {feedback && (
          <p className={`text-sm ${feedback.ok ? "text-green-400" : "text-red-400"}`}>
            {feedback.msg}
          </p>
        )}
      </form>

      <div className="chat-scroll min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2 sm:px-4 sm:py-3">
        {allRequests.length === 0 && (
          <p className="text-center text-sm text-gray-500">Nog geen verzoekjes</p>
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
              <div className="flex gap-2.5 p-2.5 sm:gap-3 sm:p-3">
                {r.thumbnail && (
                  <img
                    src={r.thumbnail}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded-md object-cover sm:h-14 sm:w-20"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold text-violet-400">
                      {r.nickname}
                    </span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${cfg.color}`}>
                      {cfg.label}
                    </span>
                  </div>
                  {r.title ? (
                    <>
                      <p className="truncate text-sm font-medium text-white">{r.title}</p>
                      {r.artist && (
                        <p className="truncate text-xs text-gray-400">{r.artist}</p>
                      )}
                    </>
                  ) : (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-sm text-violet-400 underline decoration-violet-400/30 hover:decoration-violet-400"
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

      {showResults && results.length > 0 && (
        <div className="absolute left-3 right-3 top-40 z-50 max-h-80 overflow-y-auto rounded-xl border border-gray-700 bg-gray-900 shadow-2xl shadow-black/50 sm:left-4 sm:right-4">
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => { void selectResult(r); }}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-gray-800/80 first:rounded-t-xl last:rounded-b-xl"
            >
              <img src={r.thumbnail} alt="" className="h-12 w-16 shrink-0 rounded-md object-cover" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">{r.title}</p>
                <div className="flex items-center gap-2">
                  {r.channel && <span className="truncate text-xs text-gray-400">{r.channel}</span>}
                  {r.duration !== null && (
                    <span className="shrink-0 text-xs tabular-nums text-gray-500">
                      {Math.floor(r.duration / 60)}:{String(r.duration % 60).padStart(2, "0")}
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
