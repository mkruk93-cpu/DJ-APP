"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useRadioStore } from "@/lib/radioStore";
import { isSpotifyConfigured } from "@/lib/spotify";
import { getGenres, getGenreHits, type GenreOption, type GenreHit } from "@/lib/radioApi";
import { buildGroupedGenreSections, GENRE_FALLBACK_OPTIONS, getGenreGroupMembers, isGroupedParentGenre, resolveGenreLabel } from "@/lib/genreDropdown";
import SpotifyBrowser from "@/components/SpotifyBrowser";
import SharedPlaylistsBrowser from "@/components/SharedPlaylistsBrowser";

interface Request {
  id: string;
  nickname: string;
  url: string;
  title: string | null;
  artist: string | null;
  thumbnail: string | null;
  duration?: number | null;
  source?: string | null;
  genre?: string | null;
  genre_confidence?: "explicit" | "artist_based" | "unknown" | null;
  status: string;
  created_at: string;
}

type SearchSource = "youtube" | "soundcloud" | "spotify" | "genres" | "playlists";

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

interface ManualResolveCandidate {
  provider: "youtube" | "soundcloud" | "spotdl";
  url: string;
  title: string;
  channel: string;
  duration: number | null;
  thumbnail: string | null;
}

interface PendingManualResolve {
  query: string;
  sourceType: string;
  sourceGenre?: string | null;
  sourcePlaylist?: string | null;
  artist?: string | null;
  title?: string | null;
}

type OwnRequestStatusUpdate = {
  requestId: string;
  title: string | null;
  artist: string | null;
  previousStatus: string;
  status: string;
};

function normalizeLoose(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const URL_REGEX = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|soundcloud\.com)\/.+$/i;
const COOLDOWN_SEC = 20;
const GENRE_PAGE_SIZE = 20;

const FALLBACK_GENRES: GenreOption[] = GENRE_FALLBACK_OPTIONS;

const statusConfig: Record<string, { label: string; color: string }> = {
  pending: { label: "Wachtrij", color: "bg-yellow-500/20 text-yellow-400" },
  approved: { label: "Goedgekeurd", color: "bg-green-500/20 text-green-400" },
  downloaded: { label: "Gedownload", color: "bg-violet-500/20 text-violet-400" },
  rejected: { label: "Afgekeurd", color: "bg-red-500/20 text-red-400" },
  error: { label: "Download mislukt", color: "bg-orange-500/20 text-orange-400" },
};

export default function RequestForm(
  { onNewRequest, onOwnRequestStatusUpdate }: {
    onNewRequest?: () => void;
    onOwnRequestStatusUpdate?: (update: OwnRequestStatusUpdate) => void;
  } = {},
) {
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);
  const [allRequests, setAllRequests] = useState<Request[]>([]);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [source, setSource] = useState<SearchSource>("youtube");
  const [includeLocal, setIncludeLocal] = useState(false);
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
  const [pendingManualResolve, setPendingManualResolve] = useState<PendingManualResolve | null>(null);
  const [manualResolveCandidates, setManualResolveCandidates] = useState<ManualResolveCandidate[]>([]);
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const genreListRef = useRef<HTMLDivElement>(null);
  const genreMenuRef = useRef<HTMLDetailsElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ownRequestStatusRef = useRef<Map<string, string>>(new Map());
  const didInitOwnStatusRef = useRef(false);
  const nickname = typeof window !== "undefined" ? localStorage.getItem("nickname") ?? "anon" : "anon";
  const serverUrl = useRadioStore((s) => s.serverUrl) ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL;
  const hideLocalDiscovery = useRadioStore((s) => s.hideLocalDiscovery);
  const activeGenreLabel = resolveGenreLabel(activeGenre, genres);
  const groupedGenreSections = useMemo(
    () => buildGroupedGenreSections(genres, genreQuery),
    [genres, genreQuery],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/requests");
      if (!res.ok) return;
      const payload = (await res.json()) as { items?: Request[] };
      setAllRequests(payload.items ?? []);
    } catch {}
  }, []);

  const search = useCallback((query: string) => {
    if (!serverUrl || query.length < 2 || (source !== "youtube" && source !== "soundcloud")) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    fetch(`${serverUrl}/search?q=${encodeURIComponent(query)}&source=${source}&includeLocal=${hideLocalDiscovery ? "0" : includeLocal ? "1" : "0"}`)
      .then((r) => r.json())
      .then((data: SearchResult[]) => {
        setResults(data);
        setShowResults(data.length > 0);
      })
      .catch(() => setResults([]))
      .finally(() => setSearching(false));
  }, [serverUrl, source, includeLocal, hideLocalDiscovery]);

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
      .then(async () => {
        const genreMembers = getGenreGroupMembers(genre);
        const pages = await Promise.allSettled(
          genreMembers.map((member) => getGenreHits(member, GENRE_PAGE_SIZE, offset, false)),
        );
        const merged = pages.flatMap((page) => (page.status === "fulfilled" ? page.value : []));
        return merged;
      })
      .then((items) => {
        const hiddenGenreNames = new Set(getGenreGroupMembers(genre).map((item) => normalizeLoose(item)));
        hiddenGenreNames.add(normalizeLoose(genre));
        const normalized = items.filter(
          (item): item is GenreHit =>
            !!item?.id
            && !!item?.title
            && !!item?.artist
            && !hiddenGenreNames.has(normalizeLoose(item.title)),
        );
        const mapped = normalized.map((item) => ({
          ...item,
          query: `${item.artist} - ${item.title}`,
        }));
        let addedUniqueCount = mapped.length;
        setGenreHits((prev) => {
          if (!append) return mapped;
          const merged = [...prev, ...mapped];
          const deduped = Array.from(
            new Map(merged.map((track) => [`${track.artist}-${track.title}`.toLowerCase(), track])).values(),
          );
          addedUniqueCount = Math.max(0, deduped.length - prev.length);
          return deduped;
        });
        setGenreHitsOffset(offset + GENRE_PAGE_SIZE);
        const groupMembers = getGenreGroupMembers(genre);
        const minExpected = Math.max(1, groupMembers.length) * GENRE_PAGE_SIZE;
        setGenreHasMore(normalized.length >= minExpected || (append && addedUniqueCount > 0));
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
    load();
    const interval = setInterval(() => {
      load();
    }, 5000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    const ownName = normalizeLoose(nickname);
    if (!ownName) return;
    const ownRequests = allRequests.filter((item) => normalizeLoose(item.nickname) === ownName);
    const nextMap = new Map<string, string>();
    for (const item of ownRequests) nextMap.set(item.id, item.status);

    if (!didInitOwnStatusRef.current) {
      ownRequestStatusRef.current = nextMap;
      didInitOwnStatusRef.current = true;
      return;
    }

    for (const item of ownRequests) {
      const previousStatus = ownRequestStatusRef.current.get(item.id);
      if (!previousStatus || previousStatus === item.status) continue;
      if (item.status === "approved" || item.status === "rejected") {
        onOwnRequestStatusUpdate?.({
          requestId: item.id,
          title: item.title ?? null,
          artist: item.artist ?? null,
          previousStatus,
          status: item.status,
        });
      }
    }
    ownRequestStatusRef.current = nextMap;
  }, [allRequests, nickname, onOwnRequestStatusUpdate]);

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

  useEffect(() => {
    if (hideLocalDiscovery) setIncludeLocal(false);
  }, [hideLocalDiscovery]);

  useEffect(() => {
    if (source === "genres") {
      if (activeGenre) loadGenreHits(activeGenre, false);
      return;
    }
    const query = input.trim();
    if (query.length >= 2 && !URL_REGEX.test(query)) {
      search(query);
    }
  }, [includeLocal, hideLocalDiscovery]); // eslint-disable-line react-hooks/exhaustive-deps

  async function resolveToUrl(query: string, preferredSource: "youtube" | "soundcloud"): Promise<SearchResult | null> {
    if (!serverUrl) return null;
    try {
      const res = await fetch(`${serverUrl}/search?q=${encodeURIComponent(query)}&source=${preferredSource}&includeLocal=${hideLocalDiscovery ? "0" : includeLocal ? "1" : "0"}`);
      if (!res.ok) return null;
      const data = await res.json() as SearchResult[];
      return data[0] ?? null;
    } catch {
      return null;
    }
  }

  async function resolveRequestSource(track: {
    query: string;
    sourceType: string;
    sourceGenre?: string | null;
    sourcePlaylist?: string | null;
    artist?: string | null;
    title?: string | null;
  }): Promise<
    | { kind: "resolved"; item: { url: string; title?: string | null; artist?: string | null; thumbnail?: string | null; duration?: number | null } }
    | { kind: "manual"; candidates: ManualResolveCandidate[] }
  > {
    if (!serverUrl) throw new Error("Control server niet bereikbaar.");
    const endpoint = `${serverUrl.replace(/\/+$/, "")}/api/downloads/resolve`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: track.title ?? null,
        artist: track.artist ?? null,
        source_type: track.sourceType,
        source_playlist: track.sourcePlaylist ?? null,
        source_genre: track.sourceGenre ?? null,
      }),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      item?: { url?: string; title?: string | null; artist?: string | null; thumbnail?: string | null; duration?: number | null };
      candidates?: ManualResolveCandidate[];
      error?: string;
    };
    if (!res.ok || !payload.item?.url) {
      const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
      if (candidates.length > 0) return { kind: "manual", candidates };
      throw new Error(payload.error ?? `Geen resultaat gevonden voor "${track.query}"`);
    }
    return {
      kind: "resolved",
      item: {
        url: payload.item.url,
        title: payload.item.title ?? null,
        artist: payload.item.artist ?? null,
        thumbnail: payload.item.thumbnail ?? null,
        duration: payload.item.duration ?? null,
      },
    };
  }

  async function submitRequest(
    rawInput: string,
    preferredSource: "youtube" | "soundcloud",
    options?: {
      providedThumb?: string;
      duration?: number | null;
      source?: string;
      genre?: string | null;
      artist?: string | null;
      title?: string | null;
    },
  ) {
    const trimmed = rawInput.trim();

    if (cooldownLeft > 0) {
      setFeedback({ msg: `Even geduld — wacht nog ${cooldownLeft}s.`, ok: false });
      return;
    }

    setSubmitting(true);
    let finalUrl = trimmed;
    let finalThumb: string | null = options?.providedThumb ?? null;
    let finalDuration: number | null = options?.duration ?? null;

    if (!URL_REGEX.test(trimmed)) {
      const resolved = await resolveToUrl(trimmed, preferredSource);
      if (!resolved) {
        setSubmitting(false);
        setFeedback({ msg: `Geen resultaat gevonden voor "${trimmed}".`, ok: false });
        return;
      }
      finalUrl = resolved.url;
      finalThumb = finalThumb ?? resolved.thumbnail ?? null;
      finalDuration = finalDuration ?? resolved.duration ?? null;
    }

    const res = await fetch("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nickname,
        url: finalUrl,
        source: options?.source ?? preferredSource,
        genre: options?.genre ?? null,
        artist: options?.artist ?? null,
        title: options?.title ?? null,
        thumbnail: finalThumb ?? null,
        duration: finalDuration,
      }),
    });

    setSubmitting(false);

    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      setFeedback({ msg: payload.error ?? "Er ging iets mis. Probeer opnieuw.", ok: false });
      return;
    }

    setInput("");
    setResults([]);
    setShowResults(false);
    setPendingManualResolve(null);
    setManualResolveCandidates([]);
    setCooldownLeft(COOLDOWN_SEC);
    setFeedback({ msg: "Verzoekje ingediend!", ok: true });
    setTimeout(() => setFeedback(null), 3000);
    load();
    onNewRequest?.();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (source === "spotify" || source === "genres" || source === "playlists") return;
    const trimmed = input.trim();
    if (!trimmed) return;
    const preferredSource = source === "soundcloud" ? "soundcloud" : "youtube";
    await submitRequest(trimmed, preferredSource);
  }

  function handleInputChange(value: string) {
    setInput(value);
    setFeedback(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (URL_REGEX.test(value.trim()) || source === "spotify" || source === "genres" || source === "playlists") {
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

  function formatDuration(seconds?: number | null): string {
    if (!seconds || seconds <= 0) return "";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  async function selectResult(result: SearchResult) {
    setInput(result.title);
    setResults([]);
    setShowResults(false);
    const preferredSource = source === "soundcloud" ? "soundcloud" : "youtube";
    const resolvedSource = result.url.startsWith("local://") ? "local" : preferredSource;
    await submitRequest(result.url, preferredSource, {
      providedThumb: result.thumbnail || undefined,
      duration: result.duration,
      source: resolvedSource,
      title: result.title,
      artist: result.channel,
    });
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
      if (genreMenuRef.current) genreMenuRef.current.open = true;
      return;
    }
    if (newSource === "spotify" || newSource === "playlists") return;
    const query = input.trim();
    if (query.length >= 2 && !URL_REGEX.test(query)) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => search(query), 100);
    }
  }

  async function handleSpotifyAdd(track: { query: string; artist?: string | null; title?: string | null }) {
    try {
      const resolved = await resolveRequestSource({
        query: track.query,
        sourceType: "spotify",
        artist: track.artist ?? null,
        title: track.title ?? null,
      });
      if (resolved.kind === "manual") {
        setPendingManualResolve({
          query: track.query,
          sourceType: "spotify",
          artist: track.artist ?? null,
          title: track.title ?? null,
        });
        setManualResolveCandidates(resolved.candidates);
        setFeedback({ msg: "Geen exacte match. Kies hieronder handmatig een versie.", ok: false });
        return "manual_select" as const;
      }
      await submitRequest(resolved.item.url, "youtube", {
        source: "spotify",
        artist: track.artist ?? resolved.item.artist ?? null,
        title: track.title ?? resolved.item.title ?? null,
        providedThumb: resolved.item.thumbnail ?? undefined,
        duration: resolved.item.duration ?? null,
      });
      return "added" as const;
    } catch {
      return "error" as const;
    }
  }

  async function handlePlaylistAdd(track: {
    query: string;
    artist?: string | null;
    title?: string | null;
    sourceType?: string | null;
    sourceGenre?: string | null;
    sourcePlaylist?: string | null;
  }) {
    try {
      const sourceType = track.sourceType ?? "shared_playlist";
      const resolved = await resolveRequestSource({
        query: track.query,
        sourceType,
        sourceGenre: track.sourceGenre ?? null,
        sourcePlaylist: track.sourcePlaylist ?? null,
        artist: track.artist ?? null,
        title: track.title ?? null,
      });
      if (resolved.kind === "manual") {
        setPendingManualResolve({
          query: track.query,
          sourceType,
          sourceGenre: track.sourceGenre ?? null,
          sourcePlaylist: track.sourcePlaylist ?? null,
          artist: track.artist ?? null,
          title: track.title ?? null,
        });
        setManualResolveCandidates(resolved.candidates);
        setFeedback({ msg: "Geen exacte match. Kies hieronder handmatig een versie.", ok: false });
        return "manual_select" as const;
      }
      await submitRequest(resolved.item.url, "youtube", {
        source: sourceType,
        genre: track.sourceGenre ?? null,
        artist: track.artist ?? resolved.item.artist ?? null,
        title: track.title ?? resolved.item.title ?? null,
        providedThumb: resolved.item.thumbnail ?? undefined,
        duration: resolved.item.duration ?? null,
      });
      return "added" as const;
    } catch {
      return "error" as const;
    }
  }

  return (
    <div ref={wrapperRef} className="relative flex h-full flex-col overflow-hidden rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5">
      <form onSubmit={handleSubmit} className="m-3 space-y-2 rounded-xl border border-gray-800 bg-gray-900 p-3 shadow-lg shadow-violet-500/5 sm:m-4 sm:p-4">
        <label className="block text-xs font-semibold uppercase tracking-wider text-violet-400">
          Nummer aanvragen
        </label>

        <div className="flex items-center gap-1 rounded-lg bg-gray-800 p-0.5">
          <button
            type="button"
            onClick={() => switchSource("youtube")}
            className={`group flex h-8 min-w-0 basis-0 items-center justify-center rounded-md px-1.5 text-[11px] font-semibold transition-all duration-200 ${
              source === "youtube"
                ? "flex-[1.4] bg-red-500/20 text-red-400"
                : "flex-1 text-gray-400 hover:text-gray-200"
            }`}
          >
            <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor">
              <path d="M23.5 6.2a3.02 3.02 0 00-2.12-2.14C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.38.56A3.02 3.02 0 00.5 6.2 31.7 31.7 0 000 12a31.7 31.7 0 00.5 5.8 3.02 3.02 0 002.12 2.14c1.88.56 9.38.56 9.38.56s7.5 0 9.38-.56a3.02 3.02 0 002.12-2.14A31.7 31.7 0 0024 12a31.7 31.7 0 00-.5-5.8zM9.55 15.5V8.5l6.27 3.5-6.27 3.5z" />
            </svg>
            <span
              className={`overflow-hidden whitespace-nowrap transition-all duration-200 ${
                source === "youtube" ? "ml-1 max-w-[86px] opacity-100" : "max-w-0 opacity-0"
              }`}
            >
              YouTube
            </span>
          </button>
          <button
            type="button"
            onClick={() => switchSource("soundcloud")}
            className={`group flex h-8 min-w-0 basis-0 items-center justify-center rounded-md px-1.5 text-[11px] font-semibold transition-all duration-200 ${
              source === "soundcloud"
                ? "flex-[1.4] bg-orange-500/20 text-orange-400"
                : "flex-1 text-gray-400 hover:text-gray-200"
            }`}
          >
            <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor">
              <path d="M1.175 12.225c-.05 0-.075.025-.075.075v4.4c0 .05.025.075.075.075s.075-.025.075-.075v-4.4c0-.05-.025-.075-.075-.075zm-.9.825c-.05 0-.075.025-.075.075v2.75c0 .05.025.075.075.075s.075-.025.075-.075v-2.75c0-.05-.025-.075-.075-.075zm1.8-.6c-.05 0-.075.025-.075.075v5c0 .05.025.075.075.075s.075-.025.075-.075v-5c0-.05-.025-.075-.075-.075zm.9-.75c-.05 0-.075.025-.075.075v6.5c0 .05.025.075.075.075s.075-.025.075-.075v-6.5c0-.05-.025-.075-.075-.075zm.9.275c-.05 0-.075.025-.075.075v5.95c0 .05.025.075.075.075s.075-.025.075-.075v-5.95c0-.05-.025-.075-.075-.075zm.9-.9c-.05 0-.075.025-.075.075v7.75c0 .05.025.075.075.075s.075-.025.075-.075v-7.75c0-.05-.025-.075-.075-.075zm.9 1.05c-.05 0-.075.025-.075.075v5.65c0 .05.025.075.075.075s.075-.025.075-.075v-5.65c0-.05-.025-.075-.075-.075zm.9-2.025c-.05 0-.075.025-.075.075v9.7c0 .05.025.075.075.075s.075-.025.075-.075v-9.7c0-.05-.025-.075-.075-.075zm.9-.475c-.05 0-.075.025-.075.075v10.65c0 .05.025.075.075.075s.075-.025.075-.075V9.55c0-.05-.025-.075-.075-.075zm.9.45c-.05 0-.075.025-.075.075v9.75c0 .05.025.075.075.075s.075-.025.075-.075v-9.75c0-.05-.025-.075-.075-.075zm1.3-.275c-.827 0-1.587.262-2.213.708a5.346 5.346 0 00-1.587-3.658A5.346 5.346 0 009.175 5C6.388 5 4.1 7.163 3.95 9.9c-.013.05-.013.1-.013.15 0 .05 0 .1.013.15h-.175c-.975 0-1.775.8-1.775 1.775v5.05c0 .975.8 1.775 1.775 1.775H12.5c2.375 0 4.3-1.925 4.3-4.3S14.875 10.2 12.5 10.2z" />
            </svg>
            <span
              className={`overflow-hidden whitespace-nowrap transition-all duration-200 ${
                source === "soundcloud" ? "ml-1 max-w-[86px] opacity-100" : "max-w-0 opacity-0"
              }`}
            >
              SoundCloud
            </span>
          </button>
          <button
            type="button"
            onClick={() => switchSource("genres")}
            className={`group flex h-8 min-w-0 basis-0 items-center justify-center rounded-md px-1.5 text-[11px] font-semibold transition-all duration-200 ${
              source === "genres"
                ? "flex-[1.4] bg-fuchsia-500/20 text-fuchsia-300"
                : "flex-1 text-gray-400 hover:text-gray-200"
            }`}
          >
            <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 3v18M3 12h18" />
            </svg>
            <span
              className={`overflow-hidden whitespace-nowrap transition-all duration-200 ${
                source === "genres" ? "ml-1 max-w-[86px] opacity-100" : "max-w-0 opacity-0"
              }`}
            >
              Genres
            </span>
          </button>
          <button
            type="button"
            onClick={() => switchSource("playlists")}
            className={`group flex h-8 min-w-0 basis-0 items-center justify-center rounded-md px-1.5 text-[11px] font-semibold transition-all duration-200 ${
              source === "playlists"
                ? "flex-[1.45] bg-blue-500/20 text-blue-300"
                : "flex-1 text-gray-400 hover:text-gray-200"
            }`}
          >
            <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            <span
              className={`overflow-hidden whitespace-nowrap transition-all duration-200 ${
                source === "playlists" ? "ml-1 max-w-[86px] opacity-100" : "max-w-0 opacity-0"
              }`}
            >
              Playlists
            </span>
          </button>
          {isSpotifyConfigured() && (
            <button
              type="button"
              onClick={() => switchSource("spotify")}
              className={`group flex h-8 min-w-0 basis-0 items-center justify-center rounded-md px-1.5 text-[11px] font-semibold transition-all duration-200 ${
                source === "spotify"
                  ? "flex-[1.4] bg-[#1DB954]/20 text-[#1DB954]"
                  : "flex-1 text-gray-400 hover:text-gray-200"
              }`}
            >
              <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
              </svg>
              <span
                className={`overflow-hidden whitespace-nowrap transition-all duration-200 ${
                  source === "spotify" ? "ml-1 max-w-[86px] opacity-100" : "max-w-0 opacity-0"
                }`}
              >
                Spotify
              </span>
            </button>
          )}
        </div>

        {source === "spotify" ? (
          <SpotifyBrowser onAddTrack={handleSpotifyAdd} submitting={submitting} />
        ) : source === "playlists" ? (
          <SharedPlaylistsBrowser onAddTrack={handlePlaylistAdd} submitting={submitting} />
        ) : source === "genres" ? (
          <div className="space-y-2">
            <input
              type="text"
              value={genreQuery}
              onChange={(e) => setGenreQuery(e.target.value)}
              onFocus={() => {
                if (genreMenuRef.current) genreMenuRef.current.open = true;
              }}
              placeholder="Zoek genre (hardstyle, trance, rock, metal...)"
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none transition focus:border-fuchsia-500"
            />
            <details ref={genreMenuRef} className="group relative z-20">
              <summary className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-gray-700 bg-gray-900/75 px-2.5 py-1.5 text-xs text-gray-200 transition hover:border-violet-500/60">
                <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-semibold text-gray-300">
                  Genre
                </span>
                <span className="min-w-0 truncate text-center text-[12px] font-semibold text-fuchsia-300">
                  {activeGenreLabel}
                </span>
                <span className="justify-self-end text-gray-400 transition group-open:rotate-180">▾</span>
              </summary>
              <div className="relative mt-1 max-h-60 overflow-y-auto rounded-md border border-gray-700 bg-gray-900/95 p-1 shadow-lg shadow-black/40">
                <button
                  type="button"
                  onClick={() => {
                    setActiveGenre(null);
                    setGenreHits([]);
                    setGenreHitsOffset(0);
                    setGenreHasMore(false);
                    if (genreMenuRef.current) genreMenuRef.current.open = false;
                  }}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition ${
                    !activeGenre
                      ? "bg-violet-600/25 text-violet-100"
                      : "text-gray-300 hover:bg-gray-800 hover:text-white"
                  }`}
                >
                  <span className="truncate">Genre selecteren</span>
                </button>
                <div className="my-1 border-b border-gray-800/80" />
                {groupedGenreSections.map((section) => {
                  const parentActive = activeGenre === section.parent.id;
                  return (
                    <div key={section.id} className="mb-1 last:mb-0">
                      <button
                        type="button"
                        onClick={() => {
                          setActiveGenre(section.parent.id);
                          loadGenreHits(section.parent.id, false);
                          if (genreMenuRef.current) genreMenuRef.current.open = false;
                        }}
                        className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs font-semibold transition ${
                          parentActive
                            ? "bg-fuchsia-600/25 text-fuchsia-100"
                            : "text-fuchsia-200 hover:bg-gray-800 hover:text-white"
                        }`}
                      >
                        <span className="truncate">{section.parent.name}</span>
                        {isGroupedParentGenre(section.parent.id) && (
                          <span className="ml-2 text-[10px] text-gray-400">alles</span>
                        )}
                      </button>
                      {section.children.map((genre) => {
                        const isActive = activeGenre === genre.id || activeGenre === genre.name;
                        return (
                          <button
                            key={`${section.id}:${genre.id}`}
                            type="button"
                            onClick={() => {
                              setActiveGenre(genre.id);
                              loadGenreHits(genre.id, false);
                              if (genreMenuRef.current) genreMenuRef.current.open = false;
                            }}
                            className={`ml-2 mt-0.5 flex w-[calc(100%-0.5rem)] items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition ${
                              isActive
                                ? "bg-violet-600/25 text-violet-100"
                                : "text-gray-300 hover:bg-gray-800 hover:text-white"
                            }`}
                          >
                            <span className="truncate">- {genre.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </details>
            {genresLoading && <p className="text-xs text-gray-400">Genres laden...</p>}
            {genreError && <p className="text-xs text-amber-300">{genreError}</p>}
            {!genresLoading && groupedGenreSections.length === 0 && (
              <p className="text-xs text-gray-400">Geen genres gevonden.</p>
            )}

            <div ref={genreListRef} className="min-h-[14rem] max-h-[56dvh] overscroll-contain overflow-y-auto rounded-lg border border-gray-800 bg-gray-950/70">
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
                      onClick={() =>
                        submitRequest(item.sourceHint?.startsWith("local://") ? item.sourceHint : item.query, "youtube", {
                          providedThumb: item.thumbnail || undefined,
                          source: item.sourceHint?.startsWith("local://") ? "local" : "genres",
                          genre: activeGenre ?? null,
                          artist: item.artist,
                          title: item.title,
                        })
                      }
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
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 pr-28 text-sm text-white placeholder-gray-500 outline-none transition focus:border-violet-500"
              />
              {!hideLocalDiscovery && (
              <button
                type="button"
                onClick={() => setIncludeLocal((prev) => !prev)}
                className={`absolute right-3 top-1/2 -translate-y-1/2 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition ${
                  includeLocal
                    ? "border-violet-500/70 bg-violet-500/20 text-violet-200"
                    : "border-gray-600 bg-gray-800/80 text-gray-300 hover:border-gray-500"
                }`}
                aria-pressed={includeLocal}
                title="Lokale tracks meenemen"
              >
                Lokaal
              </button>
              )}
              {searching && (
                <div className="absolute right-24 top-1/2 -translate-y-1/2">
                  <span className="block h-4 w-4 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
                </div>
              )}
              {showResults && results.length > 0 && (
                <div
                  data-prevent-pull-refresh="1"
                  className="absolute left-0 right-0 top-full z-40 mt-1 max-h-[45dvh] overscroll-contain overflow-y-auto rounded-xl border border-gray-700 bg-gray-900 shadow-2xl shadow-black/50 sm:max-h-80"
                >
                  {results.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => { void selectResult(r); }}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-gray-800/80 first:rounded-t-xl last:rounded-b-xl"
                    >
                      {r.thumbnail ? (
                        <img src={r.thumbnail} alt="" className="h-12 w-16 shrink-0 rounded-md object-cover" />
                      ) : (
                        <div className="flex h-12 w-16 shrink-0 items-center justify-center rounded-md bg-gray-800 text-[10px] text-gray-500">
                          lokaal
                        </div>
                      )}
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
            <button
              type="submit"
              disabled={submitting || !input.trim()}
              className="w-full rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-500 active:scale-[0.98] disabled:opacity-40"
            >
              {submitting ? "Checken..." : "Verzoek sturen"}
            </button>
          </>
        )}
        {feedback && (
          <p className={`text-sm ${feedback.ok ? "text-green-400" : "text-red-400"}`}>
            {feedback.msg}
          </p>
        )}
        {pendingManualResolve && manualResolveCandidates.length > 0 && (
          <div className="rounded-lg border border-amber-700/50 bg-amber-950/20 p-2">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-[11px] font-semibold text-amber-200">Kies handmatig de juiste versie</p>
              <button
                type="button"
                onClick={() => {
                  setPendingManualResolve(null);
                  setManualResolveCandidates([]);
                }}
                className="rounded bg-gray-700/80 px-2 py-0.5 text-[10px] text-gray-200 hover:bg-gray-600"
              >
                Sluiten
              </button>
            </div>
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {manualResolveCandidates.map((candidate) => (
                <div key={`${candidate.provider}:${candidate.url}`} className="flex items-center gap-2 rounded border border-amber-800/30 bg-gray-900/70 p-1.5">
                  {candidate.thumbnail ? (
                    <img src={candidate.thumbnail} alt="" className="h-9 w-14 rounded object-cover" />
                  ) : (
                    <div className="h-9 w-14 rounded bg-gray-800" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] text-white">{candidate.title}</p>
                    <p className="truncate text-[10px] text-gray-400">
                      {candidate.channel}
                      {candidate.duration ? ` • ${formatDuration(candidate.duration)}` : ""}
                      {` • ${candidate.provider}`}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() =>
                      submitRequest(candidate.url, "youtube", {
                        source: pendingManualResolve.sourceType,
                        genre: pendingManualResolve.sourceGenre ?? null,
                        artist: pendingManualResolve.artist ?? null,
                        title: pendingManualResolve.title ?? null,
                        providedThumb: candidate.thumbnail ?? undefined,
                        duration: candidate.duration ?? null,
                      })
                    }
                    className="rounded bg-amber-600/35 px-2 py-1 text-[10px] font-semibold text-amber-100 hover:bg-amber-600/50 disabled:opacity-40"
                  >
                    Kies
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </form>

      <div className="chat-scroll min-h-0 flex-1 space-y-2 overscroll-contain overflow-y-auto px-3 pb-3 sm:px-4 sm:pb-4">
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
                      {typeof r.duration === "number" && r.duration > 0 && (
                        <p className="truncate text-xs text-gray-500">
                          Lengte: {Math.floor(r.duration / 60)}:{String(r.duration % 60).padStart(2, "0")}
                        </p>
                      )}
                      {r.genre && (
                        <p className="truncate text-xs text-fuchsia-300">
                          Genre: {r.genre}
                          {r.genre_confidence === "artist_based" ? " (op artiest)" : ""}
                        </p>
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

    </div>
  );
}
