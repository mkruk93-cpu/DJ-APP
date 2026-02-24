"use client";

import { useState, useEffect, useRef, useCallback, Component, type ReactNode } from "react";
import { getSocket } from "@/lib/socket";
import { useRadioStore } from "@/lib/radioStore";
import { canPerformAction } from "@/lib/types";
import { isRadioAdmin, getRadioToken } from "@/lib/auth";
import { isSpotifyConfigured } from "@/lib/spotify";
import { getGenres, getGenreHits, type GenreOption, type GenreHit } from "@/lib/radioApi";
import SpotifyBrowser from "@/components/SpotifyBrowser";

class SpotifyErrorBoundary extends Component<
  { children: ReactNode; onReset: () => void },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; onReset: () => void }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
    console.warn("[spotify] Render error:", error);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <p className="text-sm text-red-400">Er ging iets mis met Spotify.</p>
          <button
            type="button"
            onClick={() => { this.setState({ hasError: false }); this.props.onReset(); }}
            className="text-xs text-violet-400 transition hover:text-violet-300"
          >
            Opnieuw proberen
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

class QueueAddErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.warn("[queue-add] Render error:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-xl border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">
          Genres kon niet geladen worden door een UI-fout. Herlaad de pagina.
        </div>
      );
    }
    return this.props.children;
  }
}

type SearchSource = "youtube" | "soundcloud" | "spotify" | "genres";

const YT_URL_REGEX =
  /^https?:\/\/(www\.)?(youtube\.com\/(watch\?.*v=|shorts\/|embed\/)|youtu\.be\/)[\w-]+/i;
const SC_URL_REGEX =
  /^https?:\/\/(www\.|m\.)?soundcloud\.com\/[\w-]+\/[\w-]+/i;

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

const FALLBACK_GENRES: GenreOption[] = [
  "hardcore",
  "hardstyle",
  "house",
  "techno",
  "hiphop",
  "metal",
  "nederlands",
  "drum and bass",
  "trance",
  "dance",
  "pop",
  "rock",
  "reggaeton",
  "r&b",
  "afrobeats",
  "latin",
  "edm",
  "psytrance",
  "uptempo",
  "rawstyle",
  "frenchcore",
  "gabber",
].map((name) => ({ id: name, name }));

function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function isSupportedUrl(input: string): boolean {
  return YT_URL_REGEX.test(input) || SC_URL_REGEX.test(input);
}

export default function QueueAdd() {
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);
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
  const mode = useRadioStore((s) => s.mode);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const genreListRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const GENRE_PAGE_SIZE = 20;

  const serverUrl = useRadioStore((s) => s.serverUrl) ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL;
  const canAdd = canPerformAction(mode, "add_to_queue", isRadioAdmin());
  const isUrl = isSupportedUrl(input.trim());

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
    getGenres(query)
      .then((items) => {
        const normalized = items.filter(
          (item): item is GenreOption => !!item?.id && !!item?.name,
        );
        if (normalized.length > 0) {
          setGenres(normalized);
          return;
        }
        // Keep UI usable when remote provider returns no genres.
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
    getGenreHits(genre, GENRE_PAGE_SIZE, offset)
      .then((items) => {
        const normalized = items.filter(
          (item): item is GenreHit =>
            !!item?.id && !!item?.title && !!item?.artist,
        );
        const mapped = normalized.map((item) => ({
          ...item,
          query: `${item.artist} - ${item.title}`,
        }));
        setGenreHits((prev) => {
          if (!append) return mapped;
          const merged = [...prev, ...mapped];
          const deduped = Array.from(
            new Map(merged.map((track) => [`${track.artist}-${track.title}`.toLowerCase(), track])).values(),
          );
          return deduped;
        });
        setGenreHitsOffset(offset + mapped.length);
        setGenreHasMore(mapped.length >= GENRE_PAGE_SIZE);
      })
      .catch(() => {
        if (!append) {
          setGenreHits([]);
        }
        setGenreHasMore(false);
      })
      .finally(() => {
        setGenreHitsLoading(false);
        setGenreHitsLoadingMore(false);
      });
  }, [serverUrl, genreHitsOffset]);

  useEffect(() => {
    if (source !== "genres" || !activeGenre) return;
    const genre = activeGenre;
    const listEl = genreListRef.current;
    if (!listEl) return;

    function onScroll() {
      if (!listEl) return;
      if (!genreHasMore || genreHitsLoading || genreHitsLoadingMore) return;
      const remaining = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
      if (remaining < 80) {
        loadGenreHits(genre, true);
      }
    }

    listEl.addEventListener("scroll", onScroll);
    return () => listEl.removeEventListener("scroll", onScroll);
  }, [source, activeGenre, genreHasMore, genreHitsLoading, genreHitsLoadingMore, loadGenreHits]);

  useEffect(() => {
    if (source !== "genres") return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => loadGenres(genreQuery), 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [genreQuery, source, loadGenres]);

  if (!canAdd) return null;

  function handleInputChange(value: string) {
    setInput(value);
    setFeedback(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (isSupportedUrl(value.trim())) {
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

  function submitUrl(url: string, thumbnail?: string) {
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

    socket.emit("queue:add", {
      youtube_url: url,
      added_by: nickname,
      token: getRadioToken(),
      ...(thumbnail ? { thumbnail } : {}),
    });

    setTimeout(() => {
      if (submitting) {
        cleanup();
        setSubmitting(false);
      }
    }, 30_000);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (source === "spotify" || source === "genres") return;
    const trimmed = input.trim();

    if (!isSupportedUrl(trimmed)) {
      if (results.length > 0) {
        selectResult(results[0]);
      } else {
        setFeedback({ msg: "Zoek een nummer of plak een YouTube/SoundCloud link.", ok: false });
      }
      return;
    }

    submitUrl(trimmed);
  }

  function selectResult(result: SearchResult) {
    setInput(result.title);
    setResults([]);
    setShowResults(false);
    submitUrl(result.url, result.thumbnail || undefined);
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
    if (query.length >= 2 && !isSupportedUrl(query)) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        setSearching(true);
        const url = serverUrl ?? "";
        fetch(`${url}/search?q=${encodeURIComponent(query)}&source=${newSource}`)
          .then((r) => r.json())
          .then((data: SearchResult[]) => {
            setResults(data);
            setShowResults(data.length > 0);
          })
          .catch(() => setResults([]))
          .finally(() => setSearching(false));
      }, 100);
    }
  }

  function handleSpotifyAdd(searchQuery: string) {
    submitUrl(searchQuery);
  }

  return (
    <QueueAddErrorBoundary>
      <div ref={wrapperRef} className="relative">
      <form onSubmit={handleSubmit} className="space-y-2 rounded-xl border border-gray-800 bg-gray-900 p-3 shadow-lg shadow-violet-500/5 sm:p-4">
        <label className="block text-xs font-semibold uppercase tracking-wider text-violet-400">
          Nummer toevoegen
        </label>

        {/* Source tabs */}
        <div className="flex gap-1 rounded-lg bg-gray-800 p-0.5">
          <button
            type="button"
            onClick={() => switchSource("youtube")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
              source === "youtube"
                ? "bg-red-500/20 text-red-400"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M23.5 6.2a3.02 3.02 0 00-2.12-2.14C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.38.56A3.02 3.02 0 00.5 6.2 31.7 31.7 0 000 12a31.7 31.7 0 00.5 5.8 3.02 3.02 0 002.12 2.14c1.88.56 9.38.56 9.38.56s7.5 0 9.38-.56a3.02 3.02 0 002.12-2.14A31.7 31.7 0 0024 12a31.7 31.7 0 00-.5-5.8zM9.55 15.5V8.5l6.27 3.5-6.27 3.5z" />
            </svg>
            YouTube
          </button>
          <button
            type="button"
            onClick={() => switchSource("soundcloud")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
              source === "soundcloud"
                ? "bg-orange-500/20 text-orange-400"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M1.175 12.225c-.05 0-.075.025-.075.075v4.4c0 .05.025.075.075.075s.075-.025.075-.075v-4.4c0-.05-.025-.075-.075-.075zm-.9.825c-.05 0-.075.025-.075.075v2.75c0 .05.025.075.075.075s.075-.025.075-.075v-2.75c0-.05-.025-.075-.075-.075zm1.8-.6c-.05 0-.075.025-.075.075v5c0 .05.025.075.075.075s.075-.025.075-.075v-5c0-.05-.025-.075-.075-.075zm.9-.75c-.05 0-.075.025-.075.075v6.5c0 .05.025.075.075.075s.075-.025.075-.075v-6.5c0-.05-.025-.075-.075-.075zm.9.275c-.05 0-.075.025-.075.075v5.95c0 .05.025.075.075.075s.075-.025.075-.075v-5.95c0-.05-.025-.075-.075-.075zm.9-.9c-.05 0-.075.025-.075.075v7.75c0 .05.025.075.075.075s.075-.025.075-.075v-7.75c0-.05-.025-.075-.075-.075zm.9 1.05c-.05 0-.075.025-.075.075v5.65c0 .05.025.075.075.075s.075-.025.075-.075v-5.65c0-.05-.025-.075-.075-.075zm.9-2.025c-.05 0-.075.025-.075.075v9.7c0 .05.025.075.075.075s.075-.025.075-.075v-9.7c0-.05-.025-.075-.075-.075zm.9-.475c-.05 0-.075.025-.075.075v10.65c0 .05.025.075.075.075s.075-.025.075-.075V9.55c0-.05-.025-.075-.075-.075zm.9.45c-.05 0-.075.025-.075.075v9.75c0 .05.025.075.075.075s.075-.025.075-.075v-9.75c0-.05-.025-.075-.075-.075zm1.3-.275c-.827 0-1.587.262-2.213.708a5.346 5.346 0 00-1.587-3.658A5.346 5.346 0 009.175 5C6.388 5 4.1 7.163 3.95 9.9c-.013.05-.013.1-.013.15 0 .05 0 .1.013.15h-.175c-.975 0-1.775.8-1.775 1.775v5.05c0 .975.8 1.775 1.775 1.775H12.5c2.375 0 4.3-1.925 4.3-4.3S14.875 10.2 12.5 10.2z" />
            </svg>
            SoundCloud
          </button>
          <button
            type="button"
            onClick={() => switchSource("genres")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
              source === "genres"
                ? "bg-fuchsia-500/20 text-fuchsia-300"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 3v18M3 12h18" />
            </svg>
            Genres
          </button>
          {isSpotifyConfigured() && (
            <button
              type="button"
              onClick={() => switchSource("spotify")}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                source === "spotify"
                  ? "bg-[#1DB954]/20 text-[#1DB954]"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
              </svg>
              Spotify
            </button>
          )}
        </div>

        {source === "spotify" ? (
          <SpotifyErrorBoundary onReset={() => switchSource("youtube")}>
            <SpotifyBrowser onAddTrack={handleSpotifyAdd} submitting={submitting} />
          </SpotifyErrorBoundary>
        ) : source === "genres" ? (
          <div className="space-y-2">
            <input
              type="text"
              value={genreQuery}
              onChange={(e) => setGenreQuery(e.target.value)}
              placeholder="Zoek genre (hardstyle, techno, hiphop, nederlands...)"
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
            {genresLoading && (
              <p className="text-xs text-gray-400">Genres laden...</p>
            )}
            {genreError && (
              <p className="text-xs text-amber-300">{genreError}</p>
            )}
            {!genresLoading && genres.length === 0 && (
              <p className="text-xs text-gray-400">Geen genres gevonden. Probeer een andere zoekterm.</p>
            )}

            <div ref={genreListRef} className="max-h-64 overflow-y-auto rounded-lg border border-gray-800 bg-gray-950/70">
              {genreHitsLoading ? (
                <p className="px-3 py-3 text-xs text-gray-400">Hitlijst laden...</p>
              ) : genreHits.length === 0 ? (
                <p className="px-3 py-3 text-xs text-gray-400">
                  Kies een genre om relevante tracks te tonen.
                </p>
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
                      onClick={() => submitUrl(item.query, item.thumbnail || undefined)}
                      disabled={submitting}
                      className="rounded-md bg-violet-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50"
                    >
                      Toevoegen
                    </button>
                  </div>
                ))
              )}
              {genreHitsLoadingMore && (
                <p className="px-3 py-2 text-xs text-gray-400">Meer tracks laden...</p>
              )}
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
                placeholder={
                  source === "youtube"
                    ? "Zoek op YouTube of plak een link..."
                    : "Zoek op SoundCloud of plak een link..."
                }
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
          </>
        )}
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
    </QueueAddErrorBoundary>
  );
}
