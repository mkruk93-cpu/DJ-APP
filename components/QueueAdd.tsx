"use client";

import { useState, useEffect, useRef, useCallback, useMemo, Component, type ReactNode } from "react";
import { getSocket } from "@/lib/socket";
import { useRadioStore } from "@/lib/radioStore";
import { canPerformAction } from "@/lib/types";
import { useIsAdmin } from "@/lib/useIsAdmin";
import { getRadioToken } from "@/lib/auth";
import { isSpotifyConfigured } from "@/lib/spotify";
import { getGenres, getGenreHits, addPriorityArtistToGenre, blockArtistForGenre, type GenreOption, type GenreHit } from "@/lib/radioApi";
import { buildGroupedGenreSections, GENRE_FALLBACK_OPTIONS, getGenreGroupMembers, isGroupedParentGenre, resolveGenreLabel } from "@/lib/genreDropdown";
import { listFavoriteArtists, addFavoriteArtist, removeFavoriteArtist, type FavoriteArtist } from "@/lib/userPlaylistsApi";
import SpotifyBrowser from "@/components/SpotifyBrowser";
import SharedPlaylistsBrowser from "@/components/SharedPlaylistsBrowser";
import { NoAutofillInput } from "@/components/NoAutofillInput";
import TrackActions from "@/components/TrackActions";

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

type SearchSource = "search" | "video" | "spotify" | "genres" | "playlists";

const URL_REGEX = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|soundcloud\.com)\/.+$/i;
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

interface SearchHistoryItem {
  id: string;
  query: string;
  created_at: string;
}

interface MusicBrainzArtist {
  id: string;
  name: string;
  country: string | null;
  type: string | null;
  disambiguation: string | null;
  image: string | null;
}

interface LastFmTrack {
  name: string;
  rank: number;
  playcount: string;
  listeners: string;
  duration: number | null;
  artist: { name: string };
  url: string;
}

interface ITunesAlbum {
  collectionId: number;
  collectionName: string;
  artistName: string;
  artworkUrl100: string;
}

interface GenreHitRow extends GenreHit {
  query: string;
}

interface QueueAddManualCandidate {
  provider: "youtube" | "soundcloud" | "spotdl";
  url: string;
  title: string;
  channel: string;
  duration: number | null;
  thumbnail: string | null;
  score: number;
  reasons: string[];
}

interface QueueAddResponse {
  ok: boolean;
  status?: "added" | "manual_select";
  error?: string;
  message?: string;
  candidates?: QueueAddManualCandidate[];
}

type AddTrackResult = "added" | "manual_select" | "error";

interface RecentAddState {
  key: string;
  url: string;
  title: string;
  artist?: string | null;
  addedBy: string;
  requestedAt: number;
  until: number;
}

interface PendingUndoState {
  key: string;
  url: string;
  title: string;
  artist?: string | null;
  addedBy: string;
  requestedAt: number;
}

interface PendingManualSelection {
  sourceKey: string;
  title: string;
  artist: string | null;
  sourceType: string | null;
  sourceGenre: string | null;
  sourcePlaylist: string | null;
  candidates: QueueAddManualCandidate[];
}

const FALLBACK_GENRES: GenreOption[] = GENRE_FALLBACK_OPTIONS;

function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function isSupportedUrl(input: string): boolean {
  return YT_URL_REGEX.test(input) || SC_URL_REGEX.test(input);
}

function normalizeLoose(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getSearchResultDedupKey(result: SearchResult): string {
  const urlKey = normalizeLoose(result.url ?? "");
  if (urlKey) return `url:${urlKey}`;

  const titleKey = normalizeLoose(result.title ?? "");
  const channelKey = normalizeLoose(result.channel ?? "");
  if (titleKey || channelKey) return `meta:${channelKey}:${titleKey}`;

  return `id:${result.id}`;
}

function dedupeSearchResults(items: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = getSearchResultDedupKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default function QueueAdd({ username }: { username?: string } = {}) {
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchingMore, setSearchingMore] = useState(false);
  const [searchOffset, setSearchOffset] = useState(0);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [source, setSource] = useState<SearchSource>("search");
  const [includeSets, setIncludeSets] = useState(false);
  const [includeLocal, setIncludeLocal] = useState(false);
  const [resultStatus, setResultStatus] = useState<Record<string, "idle" | "pending" | "added">>({});
  const [recentAdd, setRecentAdd] = useState<RecentAddState | null>(null);
  const [pendingUndo, setPendingUndo] = useState<PendingUndoState | null>(null);
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(0);
  const [genreQuery, setGenreQuery] = useState("");
  const [genres, setGenres] = useState<GenreOption[]>([]);
  const [genresLoading, setGenresLoading] = useState(false);
  const [genreHits, setGenreHits] = useState<GenreHitRow[]>([]);
  const [genreHitsLoading, setGenreHitsLoading] = useState(false);
  const [genreHitsLoadingMore, setGenreHitsLoadingMore] = useState(false);
  const [genreHitsOffset, setGenreHitsOffset] = useState(0);
  const [genreHasMore, setGenreHasMore] = useState(false);
  const [genrePrioritySaving, setGenrePrioritySaving] = useState<Record<string, boolean>>({});
  const [genrePrioritySaved, setGenrePrioritySaved] = useState<Record<string, boolean>>({});
  const [genreBlockSaving, setGenreBlockSaving] = useState<Record<string, boolean>>({});
  const [genreBlockSaved, setGenreBlockSaved] = useState<Record<string, boolean>>({});
  const [activeGenre, setActiveGenre] = useState<string | null>(null);
  const [genreError, setGenreError] = useState<string | null>(null);
  const [pendingManualSelection, setPendingManualSelection] = useState<PendingManualSelection | null>(null);
  
  // Artist search state (for new "search" source)
  const [artistSearchQuery, setArtistSearchQuery] = useState("");
  const [artistResults, setArtistResults] = useState<MusicBrainzArtist[]>([]);
  const [artistSearching, setArtistSearching] = useState(false);
  const [selectedArtist, setSelectedArtist] = useState<MusicBrainzArtist | null>(null);
  const [artistTracks, setArtistTracks] = useState<LastFmTrack[]>([]);
  const [artistTracksLoading, setArtistTracksLoading] = useState(false);
  const [artistTracksPage, setArtistTracksPage] = useState(1);
  const [artistTracksHasMore, setArtistTracksHasMore] = useState(false);
  const [artistTracksLoadingMore, setArtistTracksLoadingMore] = useState(false);
  const [artistTrackFilter, setArtistTrackFilter] = useState("");
  const [artistAlbums, setArtistAlbums] = useState<ITunesAlbum[]>([]);
  const [artistAlbumsLoading, setArtistAlbumsLoading] = useState(false);
  const [showArtistResults, setShowArtistResults] = useState(false);
  const [artistHistory, setArtistHistory] = useState<SearchHistoryItem[]>([]);
  const [showArtistHistory, setShowArtistHistory] = useState(false);
  const [videoHistory, setVideoHistory] = useState<SearchHistoryItem[]>([]);
  const [showVideoHistory, setShowVideoHistory] = useState(false);
  const [addedTrackId, setAddedTrackId] = useState<string | null>(null);
  const [pendingTrackId, setPendingTrackId] = useState<string | null>(null);
  const [favoriteArtists, setFavoriteArtists] = useState<FavoriteArtist[]>([]);
  const [favoriteArtistsLoading, setFavoriteArtistsLoading] = useState(false);
  const [showFavoriteArtists, setShowFavoriteArtists] = useState(false);
  
  const [isMobile, setIsMobile] = useState(false);
  const [mobileGenreMenuTop, setMobileGenreMenuTop] = useState<number | null>(null);
  const mode = useRadioStore((s) => s.mode);
  const queue = useRadioStore((s) => s.queue);
  const hideLocalDiscovery = useRadioStore((s) => s.hideLocalDiscovery);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const genreListRef = useRef<HTMLDivElement>(null);
  const genreMenuRef = useRef<HTMLDetailsElement>(null);
  const genreSummaryRef = useRef<HTMLElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const artistLoadMoreRef = useRef<HTMLDivElement>(null);
  const searchListRef = useRef<HTMLDivElement>(null);
  const artistTracksListRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentAddTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentAddTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const genreLoadInFlightRef = useRef(false);
  const artistLoadInFlightRef = useRef(false);
  const genreNoProgressPagesRef = useRef(0);
  const genreHitsCacheRef = useRef(new Map<string, GenreHit[]>());
  const searchOffsetRef = useRef(0);
  const genreOffsetRef = useRef(0);
  const artistTracksPageRef = useRef(1);
  const searchCacheRef = useRef<Map<string, SearchResult[]>>(new Map());
  const artistCacheRef = useRef<Map<string, LastFmTrack[]>>(new Map());
  const latestSearchRunRef = useRef(0);
  const GENRE_PAGE_SIZE = 10;
  const SEARCH_PAGE_SIZE = 12;
  const ARTIST_TRACKS_PAGE_SIZE = 50;
  const MAX_ARTIST_TRACKS = 250;
  const serverUrl = useRadioStore((s) => s.serverUrl) ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL;
  const nickname = getNickname();

  const normalizeArtistName = useCallback((value: string | null | undefined) => (value ?? "").trim().toLowerCase(), []);
  const favoriteArtistIds = useMemo(() => new Set(favoriteArtists.map((artist) => artist.mbid)), [favoriteArtists]);

  const isArtistFavorited = useCallback((artistId?: string | null, artistName?: string | null) => {
    if (artistId && !artistId.startsWith("history:")) {
      return favoriteArtistIds.has(artistId);
    }
    const normalizedName = normalizeArtistName(artistName);
    return normalizedName
      ? favoriteArtists.some((artist) => normalizeArtistName(artist.name) === normalizedName)
      : false;
  }, [favoriteArtistIds, favoriteArtists, normalizeArtistName]);

  const resolveFavoriteArtist = useCallback(async (artist: {
    id?: string | null;
    name: string;
    image?: string | null;
    country?: string | null;
  }): Promise<{ mbid: string; name: string; image_url: string | null; country: string | null } | null> => {
    const normalizedName = normalizeArtistName(artist.name);
    if (!normalizedName) return null;

    if (artist.id && !artist.id.startsWith("history:")) {
      return {
        mbid: artist.id,
        name: artist.name,
        image_url: artist.image ?? null,
        country: artist.country ?? null,
      };
    }

    const existing = favoriteArtists.find((entry) => normalizeArtistName(entry.name) === normalizedName);
    if (existing) {
      return {
        mbid: existing.mbid,
        name: existing.name,
        image_url: existing.image_url ?? null,
        country: existing.country ?? null,
      };
    }

    if (!serverUrl) return null;

    try {
      const res = await fetch(`${serverUrl}/api/search/autocomplete?q=${encodeURIComponent(artist.name)}&limit=8`);
      if (!res.ok) return null;
      const data = await res.json() as MusicBrainzArtist[];
      const exactMatch = data.find((entry) => normalizeArtistName(entry.name) === normalizedName) ?? data[0];
      if (!exactMatch?.id) return null;
      return {
        mbid: exactMatch.id,
        name: exactMatch.name,
        image_url: exactMatch.image ?? artist.image ?? null,
        country: exactMatch.country ?? artist.country ?? null,
      };
    } catch {
      return null;
    }
  }, [favoriteArtists, normalizeArtistName, serverUrl]);

  const toggleFavoriteArtistState = useCallback(async (artist: {
    id?: string | null;
    name: string;
    image?: string | null;
    country?: string | null;
  }) => {
    const existingFavorite = favoriteArtists.find((entry) =>
      (artist.id && !artist.id.startsWith("history:") && entry.mbid === artist.id) ||
      normalizeArtistName(entry.name) === normalizeArtistName(artist.name)
    );

    if (existingFavorite) {
      await removeFavoriteArtist(existingFavorite.mbid);
      setFavoriteArtists((prev) => prev.filter((entry) => entry.mbid !== existingFavorite.mbid));
      return;
    }

    const resolved = await resolveFavoriteArtist(artist);
    if (!resolved) {
      setFeedback({ msg: `Kon ${artist.name} niet als favoriet opslaan. Probeer de artiest opnieuw te openen vanuit de zoekresultaten.`, ok: false });
      return;
    }

    await addFavoriteArtist(resolved);
    setFavoriteArtists((prev) => (
      prev.some((entry) => entry.mbid === resolved.mbid)
        ? prev
        : [...prev, { ...resolved, added_at: new Date().toISOString() }]
    ));

    if (selectedArtist && normalizeArtistName(selectedArtist.name) === normalizeArtistName(artist.name) && (!selectedArtist.id || selectedArtist.id.startsWith("history:"))) {
      setSelectedArtist((prev) => (prev ? {
        ...prev,
        id: resolved.mbid,
        image: prev.image ?? resolved.image_url ?? null,
        country: prev.country ?? resolved.country ?? null,
      } : prev));
    }
  }, [favoriteArtists, normalizeArtistName, resolveFavoriteArtist, selectedArtist]);

  useEffect(() => {
    setHydrated(true);
  }, []);

  // Close search results when clicking outside on mobile
  useEffect(() => {
    if (!showResults) return;

    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (searchListRef.current && !searchListRef.current.contains(event.target as Node)) {
        const inputElement = wrapperRef.current?.querySelector('input[type="text"]');
        if (inputElement && !inputElement.contains(event.target as Node)) {
          setShowResults(false);
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [showResults]);

  const fetchSearchHistory = useCallback(async (type: "artist" | "video"): Promise<SearchHistoryItem[]> => {
    if (!serverUrl || !nickname) return [];
    try {
      const res = await fetch(
        `${serverUrl}/api/search-history?nickname=${encodeURIComponent(nickname)}&type=${type}`,
      );
      const data = await res.json() as { history?: SearchHistoryItem[] };
      return Array.isArray(data.history) ? data.history : [];
    } catch {
      return [];
    }
  }, [nickname, serverUrl]);

  const refreshSearchHistory = useCallback(async (type: "artist" | "video") => {
    const history = await fetchSearchHistory(type);
    if (type === "artist") {
      setArtistHistory(history);
    } else {
      setVideoHistory(history);
    }
  }, [fetchSearchHistory]);

  // Load search history
  useEffect(() => {
    if (!serverUrl || !nickname) return;
    Promise.all([
      fetchSearchHistory("artist"),
      fetchSearchHistory("video"),
    ]).then(([artistHist, videoHist]) => {
      setArtistHistory(artistHist);
      setVideoHistory(videoHist);
    }).catch(() => {});
  }, [fetchSearchHistory, nickname, serverUrl]);

  // Delete search history item
  const deleteHistoryItem = useCallback(async (type: 'artist' | 'video', id: string) => {
    if (!serverUrl) return;
    try {
      await fetch(`${serverUrl}/api/search-history`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (type === 'artist') {
        setArtistHistory((prev) => prev.filter((h) => h.id !== id));
      } else {
        setVideoHistory((prev) => prev.filter((h) => h.id !== id));
      }
    } catch {}
  }, [serverUrl]);

  const isAdmin = useIsAdmin();
  const canAdd = hydrated && canPerformAction(mode, "add_to_queue", isAdmin);
  const isUrl = isSupportedUrl(input.trim());
  const hasSpotifySource = isSpotifyConfigured();
  const activeGenreLabel = resolveGenreLabel(activeGenre, genres);
  const groupedGenreSections = useMemo(
    () => buildGroupedGenreSections(genres, genreQuery),
    [genres, genreQuery],
  );
  const showGenreHitsPanel = !!activeGenre || genreHitsLoading || genreHits.length > 0 || genreHitsLoadingMore;

  function filterSetResults(items: SearchResult[]): SearchResult[] {
    if (includeSets) return items;
    return items.filter((item) => item.duration === null || item.duration <= 900);
  }

  function filterLongTracks(items: GenreHitRow[]): GenreHitRow[] {
    // Filter out tracks longer than 7 minutes (420 seconds) for genre hits
    return items.filter((item) => {
      // If duration is available and longer than 7 minutes, filter it out
      if (item.duration && item.duration > 420) {
        console.log(`[genre-hits] Frontend filtered long track: ${item.title} (${Math.floor(item.duration / 60)}:${String(item.duration % 60).padStart(2, '0')})`);
        return false;
      }
      return true;
    });
  }

  function setSearchOffsetSafe(next: number) {
    searchOffsetRef.current = next;
    setSearchOffset(next);
  }

  function setGenreOffsetSafe(next: number) {
    genreOffsetRef.current = next;
    setGenreHitsOffset(next);
  }

  function getNickname(): string {
    return username || (typeof window !== "undefined"
      ? (localStorage.getItem("nickname") ?? "Gast")
      : "Gast");
  }

  function normalizeForMatch(value: string | null | undefined): string {
    return (value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getPrimaryArtist(rawArtist: string): string {
    const first = rawArtist
      .split(/[,&/]| feat\.| ft\./i)
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    return first ?? rawArtist.trim();
  }

  function titleMatchesUndoCandidate(queueTitle: string | null | undefined, pending: PendingUndoState): boolean {
    const queueNorm = normalizeForMatch(queueTitle);
    const pendingNorm = normalizeForMatch(
      pending.artist ? `${pending.artist} ${pending.title}` : pending.title,
    );
    if (!queueNorm || !pendingNorm) return false;
    if (queueNorm.includes(pendingNorm) || pendingNorm.includes(queueNorm)) return true;
    const tokens = pendingNorm.split(" ").filter((token) => token.length > 2);
    if (tokens.length === 0) return false;
    const hits = tokens.filter((token) => queueNorm.includes(token)).length;
    return hits >= Math.max(2, Math.ceil(tokens.length * 0.5));
  }

  function findQueueItemForUndo(candidate: PendingUndoState) {
    const queueByNewest = [...queue].reverse();
    const minCreatedAt = candidate.requestedAt - 20_000;
    const urlMatchFresh = queueByNewest.find((item) => {
      if (item.youtube_url !== candidate.url) return false;
      const createdAtMs = Date.parse(item.created_at ?? "");
      return Number.isFinite(createdAtMs) ? createdAtMs >= minCreatedAt : true;
    });
    if (urlMatchFresh) return urlMatchFresh;
    const urlMatchAny = queueByNewest.find((item) => item.youtube_url === candidate.url);
    if (urlMatchAny) return urlMatchAny;
    const ownerMatchFresh = queueByNewest.find((item) => {
      if ((item.added_by ?? "").toLowerCase() !== candidate.addedBy.toLowerCase()) return false;
      const createdAtMs = Date.parse(item.created_at ?? "");
      if (Number.isFinite(createdAtMs) && createdAtMs < minCreatedAt) return false;
      return titleMatchesUndoCandidate(item.title, candidate);
    });
    if (ownerMatchFresh) return ownerMatchFresh;
    return queueByNewest.find((item) => {
      if ((item.added_by ?? "").toLowerCase() !== candidate.addedBy.toLowerCase()) return false;
      return titleMatchesUndoCandidate(item.title, candidate);
    }) ?? null;
  }

  function startRecentAdd(
    key: string,
    url: string,
    title: string,
    artist?: string | null,
  ): RecentAddState {
    const now = Date.now();
    const next: RecentAddState = {
      key,
      url,
      title,
      artist,
      addedBy: getNickname(),
      requestedAt: now,
      until: now + 6500,
    };
    if (recentAddTimerRef.current) clearTimeout(recentAddTimerRef.current);
    setRecentAdd(next);
    recentAddTimerRef.current = setTimeout(() => setRecentAdd(null), 6500);
    return next;
  }

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

  const search = useCallback((query: string, append = false) => {
    if (!serverUrl || query.length < 2) {
      latestSearchRunRef.current += 1;
      setResults([]);
      setSearchOffsetSafe(0);
      setSearchHasMore(false);
      setSearchQuery("");
      setSearching(false);
      setSearchingMore(false);
      return;
    }

    const useLocal = hideLocalDiscovery ? false : includeLocal;
    const offset = append ? searchOffsetRef.current : 0;
    const runId = ++latestSearchRunRef.current;
    if (append) setSearchingMore(true);
    else setSearching(true);

    const sources = source === "video" ? ["soundcloud", "youtube"] : [source];

    // Check frontend cache for initial searches (offset 0)
    const cacheKey = `${source}:${query.toLowerCase()}:${useLocal ? 'local' : 'remote'}`;
    if (!append && searchCacheRef.current.has(cacheKey)) {
      const cached = searchCacheRef.current.get(cacheKey)!;
      setResults(cached);
      setSearchQuery(query);
      setSearchOffsetSafe(cached.length);
      setSearchHasMore(true);
      setShowResults(cached.length > 0);
      setSearching(false);
      return;
    }

    Promise.all(
      sources.map(async (platform) => {
        const res = await fetch(
          `${serverUrl}/search?q=${encodeURIComponent(query)}&source=${platform}&limit=${SEARCH_PAGE_SIZE}&offset=${offset}&includeLocal=${useLocal ? "1" : "0"}`,
        );
        if (!res.ok) return [] as SearchResult[];
        const data = await res.json() as SearchResult[];
        return Array.isArray(data) ? data : [];
      }),
    )
      .then((groups) => {
        if (runId !== latestSearchRunRef.current) return;
        
        // Close search history dropdown when results are loaded
        setShowVideoHistory(false);

        const deduped = dedupeSearchResults(groups.flat());
        const visible = filterSetResults(deduped);
        setResults((prev) => {
          const next = !append ? visible : dedupeSearchResults([...prev, ...visible]);
          // Cache the results for initial search to speed up source/tab switching
          if (!append) {
            const cacheKey = `${source}:${query.toLowerCase()}:${useLocal ? 'local' : 'remote'}`;
            searchCacheRef.current.set(cacheKey, next);
          }
          return next;
        });
        setSearchQuery(query);
        setSearchOffsetSafe(offset + deduped.length);

        // Improved logic for hasMore when local files are included
        if (useLocal && offset < 30) {
          setSearchHasMore(true);
        } else {
          setSearchHasMore(deduped.length > 0);
        }

        setShowResults(append ? true : visible.length > 0);
      })
      .catch(() => {
        if (runId !== latestSearchRunRef.current) return;
        if (!append) {
          setResults([]);
          setSearchOffsetSafe(0);
          setSearchHasMore(false);
        } else {
          if (useLocal && searchOffsetRef.current < 30) {
            setSearchHasMore(true);
          } else {
            setSearchHasMore(false);
          }
        }
      })
      .finally(() => {
        if (runId !== latestSearchRunRef.current) return;
        setSearching(false);
        setSearchingMore(false);
      });
  }, [serverUrl, source, includeSets, includeLocal, hideLocalDiscovery]);

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

  // Artist search - MusicBrainz/Last.fm autocomplete
  const searchArtists = useCallback(async (query: string) => {
    if (!serverUrl || query.length < 2) {
      setArtistResults([]);
      setShowArtistResults(false);
      return;
    }
    setArtistSearching(true);
    try {
      const res = await fetch(`${serverUrl}/api/search/autocomplete?q=${encodeURIComponent(query)}&limit=10`);
      const data = await res.json() as MusicBrainzArtist[];
      setArtistResults(data);
      setShowArtistResults(data.length > 0);
      
      // Close artist history dropdown when results are loaded
      setShowArtistHistory(false);
    } catch {
      setArtistResults([]);
    } finally {
      setArtistSearching(false);
    }
  }, [serverUrl, nickname, refreshSearchHistory]);

  const setArtistTracksPageSafe = useCallback((page: number) => {
    setArtistTracksPage(page);
    artistTracksPageRef.current = page;
  }, []);

  // Load artist tracks from Last.fm
  const loadArtistTracks = useCallback(async (artistName: string, append = false) => {
    if (!serverUrl) return;
    if (artistLoadInFlightRef.current) return;
    
    const page = append ? artistTracksPageRef.current : 1;
    artistLoadInFlightRef.current = true;
    
    if (append) {
      setArtistTracksLoadingMore(true);
    } else {
      // Check frontend cache for initial artist load
      if (artistCacheRef.current.has(artistName)) {
        const cached = artistCacheRef.current.get(artistName)!;
        setArtistTracks(cached);
        setArtistTracksPageSafe(2); // Assume 1st page is cached
        setArtistTracksHasMore(cached.length >= ARTIST_TRACKS_PAGE_SIZE && cached.length < MAX_ARTIST_TRACKS);
        artistLoadInFlightRef.current = false;
        return;
      }
      setArtistTracksLoading(true);
      setArtistTracks([]);
      setArtistTracksPageSafe(1);
      setArtistTracksHasMore(false);
    }

    try {
      // Always use tracks for artist search
      const endpoint = "tracks";
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

      const res = await fetch(
        `${serverUrl}/api/artist/${endpoint}?name=${encodeURIComponent(artistName)}&limit=${ARTIST_TRACKS_PAGE_SIZE}&page=${page}&method=gettoptracks`,
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);

      const data = await res.json() as any[];
      const tracks = Array.isArray(data) ? data : [];
      
      let totalCount = 0;
      setArtistTracks((prev) => {
        const next = append ? [...prev, ...tracks] : tracks;
        // Basic dedupe
        const deduped = Array.from(new Map(next.map(t => [t.url || `${t.name}-${t.artist?.name}`, t])).values());
        totalCount = deduped.length;
        // Cache the results for initial load
        if (!append) artistCacheRef.current.set(artistName, deduped);
        return deduped;
      });
      
      setArtistTracksPageSafe(page + 1);
      setArtistTracksHasMore(tracks.length >= ARTIST_TRACKS_PAGE_SIZE && totalCount < MAX_ARTIST_TRACKS);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        console.warn("[artist-tracks] Fetch aborted due to timeout");
      } else {
        console.error("[artist-tracks] Error loading tracks:", err);
      }
      if (!append) setArtistTracks([]);
      setArtistTracksHasMore(false);
    } finally {
      artistLoadInFlightRef.current = false;
      setArtistTracksLoading(false);
      setArtistTracksLoadingMore(false);
    }
  }, [serverUrl, setArtistTracksPageSafe]);

  // Load artist artwork from iTunes + Last.fm fallback
  const [artistImageFallback, setArtistImageFallback] = useState<string | null>(null);

  const loadArtistArtwork = useCallback(async (artistName: string) => {
    if (!serverUrl) return;
    setArtistAlbumsLoading(true);
    setArtistImageFallback(null);
    
    try {
      // Load Last.fm image (skips placeholder images)
      try {
        const imgRes = await fetch(`${serverUrl}/api/artist-image?artist=${encodeURIComponent(artistName)}`);
        const imgData = await imgRes.json() as { image?: string };
        if (imgData.image) {
          setArtistImageFallback(imgData.image);
        }
      } catch {}

      // Load iTunes with more results
      const res = await fetch(`${serverUrl}/api/artwork?artist=${encodeURIComponent(artistName)}&limit=50`);
      const data = await res.json() as ITunesAlbum[];
      setArtistAlbums(data);
    } catch {
      setArtistAlbums([]);
    } finally {
      setArtistAlbumsLoading(false);
    }
  }, [serverUrl]);

  // Select an artist
  const selectArtist = useCallback(async (artist: MusicBrainzArtist) => {
    setSelectedArtist(artist);
    setArtistSearchQuery(artist.name);
    setShowArtistResults(false);
    setShowArtistHistory(false);
    setArtistResults([]);
    setArtistTracksPageSafe(1);
    setArtistTracksHasMore(false);
    setArtistTrackFilter("");
    await Promise.all([
      loadArtistTracks(artist.name, false),
      loadArtistArtwork(artist.name),
    ]);
    // Save selected artist to search history
    if (nickname && serverUrl && artist.name) {
      fetch(`${serverUrl}/api/search-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, type: 'artist', query: artist.name }),
      }).then(() => refreshSearchHistory("artist")).catch(() => {});
    }
  }, [loadArtistTracks, loadArtistArtwork, nickname, refreshSearchHistory, serverUrl, setArtistTracksPageSafe]);

  const selectArtistHistoryItem = useCallback(async (query: string) => {
    const artistName = query.trim();
    if (!artistName) return;
    const normalizedName = normalizeArtistName(artistName);
    const knownFavorite = favoriteArtists.find((artist) => normalizeArtistName(artist.name) === normalizedName);

    if (knownFavorite) {
      await selectArtist({
        id: knownFavorite.mbid,
        name: knownFavorite.name,
        country: knownFavorite.country,
        type: null,
        disambiguation: null,
        image: knownFavorite.image_url,
      });
      return;
    }

    if (serverUrl) {
      try {
        const res = await fetch(`${serverUrl}/api/search/autocomplete?q=${encodeURIComponent(artistName)}&limit=8`);
        if (res.ok) {
          const matches = await res.json() as MusicBrainzArtist[];
          const resolved = matches.find((artist) => normalizeArtistName(artist.name) === normalizedName) ?? matches[0];
          if (resolved) {
            await selectArtist(resolved);
            return;
          }
        }
      } catch {}
    }

    await selectArtist({
      id: `history:${artistName.toLowerCase()}`,
      name: artistName,
      country: null,
      type: null,
      disambiguation: null,
      image: null,
    });
  }, [favoriteArtists, normalizeArtistName, selectArtist, serverUrl]);

  // Get artwork URL with larger size
  const getArtworkUrl = (url: string, size: '100' | '300' = '300'): string => {
    if (!url) return '';
    return url.replace('100x100', `${size}x${size}`);
  };

  const loadGenreHits = useCallback((genre: string, append = false) => {
    if (!serverUrl) return;
    if (genreLoadInFlightRef.current) return;
    
    const offset = append ? genreOffsetRef.current : 0;
    console.log(`[genre-hits] Loading ${genre}, offset: ${offset}, append: ${append}`);
    
    genreLoadInFlightRef.current = true;
    if (append) {
      setGenreHitsLoadingMore(true);
    } else {
      setGenreHitsLoading(true);
      setGenreHits([]);
      setGenreOffsetSafe(0);
      setGenreHasMore(false);
      genreNoProgressPagesRef.current = 0;
    }
    setActiveGenre(genre);
    
    // Direct API call to new lightweight endpoint
    getGenreHits(genre, GENRE_PAGE_SIZE, offset, false)
      .then((items) => {
        console.log(`[genre-hits] Received ${items.length} items for ${genre}`);
        
        const mapped = items.map((item) => ({
          ...item,
          query: `${item.artist} - ${item.title}`,
        }));
        
        // Filter out tracks longer than 7 minutes
        const filtered = filterLongTracks(mapped);
        
        let addedUniqueCount = filtered.length;
        setGenreHits((prev) => {
          if (!append) return filtered;
          const merged = [...prev, ...filtered];
          const deduped = Array.from(
            new Map(merged.map((track) => [`${track.artist}-${track.title}`.toLowerCase(), track])).values(),
          );
          addedUniqueCount = Math.max(0, deduped.length - prev.length);
          return deduped;
        });
        
        const nextOffset = offset + GENRE_PAGE_SIZE;
        setGenreOffsetSafe(nextOffset);
        
        if (!append) {
          genreNoProgressPagesRef.current = 0;
        } else if (addedUniqueCount > 0) {
          genreNoProgressPagesRef.current = 0;
        } else {
          genreNoProgressPagesRef.current += 1;
        }
        
        // Has more if we got the full page size
        setGenreHasMore(items.length >= GENRE_PAGE_SIZE);
      })
      .catch((error) => {
        console.error(`[genre-hits] Error loading ${genre}:`, error);
        if (!append) {
          setGenreHits([]);
        }
        setGenreHasMore(false);
      })
      .finally(() => {
        genreLoadInFlightRef.current = false;
        setGenreHitsLoading(false);
        setGenreHitsLoadingMore(false);
      });
  }, [serverUrl]);

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
    if (source !== "search" || !selectedArtist) return;
    const root = artistTracksListRef.current;
    const sentinel = artistLoadMoreRef.current;
    if (!root || !sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        if (!visible) return;
        if (!artistTracksHasMore || artistTracksLoading || artistTracksLoadingMore) return;
        
        // If filtering and no visible tracks, don't auto-load more in a loop
        const filteredCount = artistTracks.filter(t => !artistTrackFilter || t.name.toLowerCase().includes(artistTrackFilter.toLowerCase())).length;
        if (artistTrackFilter && filteredCount === 0 && artistTracks.length > 0) return;

        loadArtistTracks(selectedArtist.name, true);
      },
      { root, rootMargin: "150px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [source, selectedArtist, artistTracksHasMore, artistTracksLoading, artistTracksLoadingMore, loadArtistTracks]);

  function handleSearchListScroll(e: React.UIEvent<HTMLDivElement>) {
    if (source === "spotify" || source === "genres" || source === "playlists") return;
    if (searching || searchingMore || !searchHasMore || !searchQuery) return;
    
    const el = e.currentTarget;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 120;
    if (nearBottom) {
      search(searchQuery, true);
    }
  }

  // Improved touch-based scroll detection for mobile
  const handleSearchListTouch = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (source === "spotify" || source === "genres" || source === "playlists") return;
    if (searching || searchingMore || !searchHasMore || !searchQuery) return;

    const el = e.currentTarget;
    // Use a more generous threshold for mobile touch scrolling
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 100;
    if (nearBottom) {
      search(searchQuery, true);
    }
  }, [source, searching, searchingMore, searchHasMore, searchQuery, search]);

  // Additional touch move handler for better mobile scroll detection
  const handleSearchListTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    // Let the touch move event bubble normally for smooth scrolling
    e.stopPropagation();
  }, []);

  function handleGenreListScroll(e: React.UIEvent<HTMLDivElement>) {
    if (source !== "genres" || !activeGenre) return;
    if (genreHitsLoading || genreHitsLoadingMore || !genreHasMore) return;
    const el = e.currentTarget;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 120;
    if (nearBottom) loadGenreHits(activeGenre, true);
  }

  useEffect(() => {
    if (source !== "genres") return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => loadGenres(genreQuery), 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [genreQuery, source, loadGenres]);

  useEffect(() => {
    if (hideLocalDiscovery) setIncludeLocal(false);
  }, [hideLocalDiscovery]);

  useEffect(() => {
    if (source !== "genres" || !activeGenre) return;
    setGenreHits([]);
    setGenreOffsetSafe(0);
    setGenreHasMore(false);
    genreNoProgressPagesRef.current = 0;
    loadGenreHits(activeGenre, false);
  }, [includeLocal, hideLocalDiscovery]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lightweight: No auto-retry to reduce server load
  // The server now always returns something, so no need for aggressive retrying

  useEffect(() => {
    function updateMobileState() {
      setIsMobile(window.innerWidth < 640);
    }
    updateMobileState();
    window.addEventListener("resize", updateMobileState);
    return () => window.removeEventListener("resize", updateMobileState);
  }, []);

  useEffect(() => {
    function updateGenreMenuPosition() {
      if (!isMobile || !genreMenuRef.current?.open || !genreSummaryRef.current) return;
      const rect = genreSummaryRef.current.getBoundingClientRect();
      setMobileGenreMenuTop(Math.max(8, Math.round(rect.bottom + 8)));
    }
    updateGenreMenuPosition();
    window.addEventListener("resize", updateGenreMenuPosition);
    window.addEventListener("scroll", updateGenreMenuPosition, { passive: true });
    return () => {
      window.removeEventListener("resize", updateGenreMenuPosition);
      window.removeEventListener("scroll", updateGenreMenuPosition);
    };
  }, [isMobile]);

  useEffect(() => {
    if (source !== "genres") return;
    if (!genreMenuRef.current) return;
    if (genreQuery.trim().length > 0) {
      genreMenuRef.current.open = true;
    }
  }, [genreQuery, source]);

  useEffect(() => {
    if (!recentAdd) {
      setUndoSecondsLeft(0);
      if (recentAddTickRef.current) {
        clearInterval(recentAddTickRef.current);
        recentAddTickRef.current = null;
      }
      return;
    }

    const tick = () => {
      const next = Math.max(0, Math.ceil((recentAdd.until - Date.now()) / 1000));
      setUndoSecondsLeft(next);
      if (next <= 0) {
        setRecentAdd(null);
        if (recentAddTickRef.current) {
          clearInterval(recentAddTickRef.current);
          recentAddTickRef.current = null;
        }
      }
    };
    tick();
    if (recentAddTickRef.current) clearInterval(recentAddTickRef.current);
    recentAddTickRef.current = setInterval(tick, 1000);
    return () => {
      if (recentAddTickRef.current) {
        clearInterval(recentAddTickRef.current);
        recentAddTickRef.current = null;
      }
    };
  }, [recentAdd]);

  useEffect(() => {
    if (!pendingUndo) return;
    const match = findQueueItemForUndo(pendingUndo);
    if (!match) return;
    getSocket().emit("queue:remove", {
      id: match.id,
      added_by: getNickname(),
      token: getRadioToken(),
    });
    setResultStatus((prev) => ({ ...prev, [pendingUndo.key]: "idle" }));
    setRecentAdd(null);
    setPendingUndo(null);
    setFeedback({ msg: "Toevoeging ongedaan gemaakt.", ok: true });
  }, [pendingUndo, queue]);

  useEffect(() => {
    if (source === "spotify" || source === "genres" || source === "playlists") return;
    const query = searchQuery.trim();
    if (query.length < 2) return;
    setSearchOffsetSafe(0);
    setSearchHasMore(false);
    search(query, false);
  }, [includeSets, includeLocal, source, searchQuery, search]);

  if (!canAdd) return null;

  function handleInputChange(value: string) {
    // Always update state first for input sync
    setInput(value);
    setFeedback(null);

    // Debounce/search logic after state update
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = value.trim();
    if (isSupportedUrl(trimmed)) {
      setResults([]);
      setSearchOffsetSafe(0);
      setSearchHasMore(false);
      setSearchQuery("");
      setShowResults(false);
      return;
    }

    if (trimmed.length >= 2) {
      debounceRef.current = setTimeout(() => search(trimmed, false), 260);
    } else {
      setResults([]);
      setSearchOffsetSafe(0);
      setSearchHasMore(false);
      setSearchQuery("");
      setShowResults(false);
    }
  }

  function showFeedback(msg: string, ok: boolean) {
    setFeedback({ msg, ok });
    setSubmitting(false);
    setTimeout(() => setFeedback(null), 5000);
  }

  function submitUrl(
    url: string,
    thumbnail?: string,
    title?: string | null,
    artist?: string | null,
    options?: {
      keepResults?: boolean;
      keepInput?: boolean;
      onError?: () => void;
      sourceType?: string | null;
      sourceGenre?: string | null;
      sourcePlaylist?: string | null;
    },
  ): Promise<QueueAddResponse> {
    return new Promise((resolve) => {
    setSubmitting(true);
    if (!options?.keepResults) setShowResults(false);

    const nickname = getNickname();

    const socket = getSocket();

    function onError(data: { message: string }) {
      showFeedback(data.message, false);
      if (!options?.keepInput) setInput("");
      options?.onError?.();
      cleanup();
      resolve({ ok: false, error: data.message });
    }

    function cleanup() {
      socket.off("error:toast", onError);
    }

    socket.on("error:toast", onError);

    socket.emit("queue:add", {
      youtube_url: url,
      added_by: nickname,
      token: getRadioToken(),
      ...(title ? { title } : {}),
      ...(artist ? { artist } : {}),
      ...(thumbnail ? { thumbnail } : {}),
      ...(options?.sourceType ? { source_type: options.sourceType } : {}),
      ...(options?.sourceGenre ? { source_genre: options.sourceGenre } : {}),
      ...(options?.sourcePlaylist ? { source_playlist: options.sourcePlaylist } : {}),
    }, (response?: QueueAddResponse) => {
      if (response) {
        if (!response.ok && response.error) {
          showFeedback(response.error, false);
        }
        resolve(response);
        return;
      }
      resolve({ ok: true, status: "added" });
    });

    // Do not block consecutive submissions while server validates this one.
    setSubmitting(false);
    if (!options?.keepInput) setInput("");

    setTimeout(() => {
      cleanup();
    }, 10_000);
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (source === "spotify" || source === "genres" || source === "playlists") return;
    const trimmed = input.trim();

    if (!isSupportedUrl(trimmed)) {
      if (results.length > 0) {
        selectResult(results[0]);
      } else {
        setFeedback({ msg: "Zoek een nummer of plak een SoundCloud of YouTube link.", ok: false });
      }
      return;
    }

    submitUrl(trimmed, undefined, null, null, {
      sourceType: source,
    });
  }

  function selectResult(result: SearchResult) {
    const key = `${source}:${result.id}`;
    setResultStatus((prev) => ({ ...prev, [key]: "pending" }));

    // Save search term to history when a result is actually selected
    if (searchQuery && nickname && serverUrl && searchQuery.trim().length >= 2) {
      fetch(`${serverUrl}/api/search-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, type: 'video', query: searchQuery.trim() }),
      }).then(() => refreshSearchHistory("video")).catch(() => {});
    }

    startRecentAdd(key, result.url, result.title, result.channel);
    setResultStatus((prev) => ({ ...prev, [key]: "added" }));
    
    submitUrl(
      result.url,
      result.thumbnail || undefined,
      result.title,
      result.channel,
      {
        keepResults: true,
        keepInput: true,
        sourceType: source,
        onError: () => {
          setResultStatus((prev) => ({ ...prev, [key]: "idle" }));
          setRecentAdd((prev) => (prev?.key === key ? null : prev));
        },
      },
    );
  }

  function undoRecentAdd() {
    if (!recentAdd) return;
    const target: PendingUndoState = {
      key: recentAdd.key,
      url: recentAdd.url,
      title: recentAdd.title,
      artist: recentAdd.artist,
      addedBy: recentAdd.addedBy,
      requestedAt: recentAdd.requestedAt,
    };
    const queueItem = findQueueItemForUndo(target);
    if (!queueItem) {
      setPendingUndo(target);
      setRecentAdd(null);
      setFeedback({ msg: "Ongedaan maken wordt uitgevoerd zodra het nummer in de wachtrij verschijnt.", ok: true });
      return;
    }
    getSocket().emit("queue:remove", {
      id: queueItem.id,
      added_by: getNickname(),
      token: getRadioToken(),
    });
    setResultStatus((prev) => ({ ...prev, [recentAdd.key]: "idle" }));
    setRecentAdd(null);
    setPendingUndo(null);
    setFeedback({ msg: "Toevoeging ongedaan gemaakt.", ok: true });
  }

  function switchSource(newSource: SearchSource) {
    setSource(newSource);
    setResults([]);
    setSearchOffsetSafe(0);
    setSearchHasMore(false);
    setSearchQuery("");
    setShowResults(false);
    setFeedback(null);
    if (newSource === "genres") {
      setInput("");
      setGenreHits([]);
      setGenreOffsetSafe(0);
      setGenreHasMore(false);
      genreNoProgressPagesRef.current = 0;
      setActiveGenre(null);
      loadGenres(genreQuery);
      return;
    }
    if (newSource === "spotify" || newSource === "playlists") return;
    const query = input.trim();
    if (query.length >= 2 && !isSupportedUrl(query)) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        search(query, false);
      }, 100);
    }
  }

  async function handleSpotifyAdd(track: {
    id?: string;
    query: string;
    artist?: string | null;
    title?: string | null;
    sourceType?: string | null;
    sourceGenre?: string | null;
    sourcePlaylist?: string | null;
    artwork_url?: string | null;
  }): Promise<AddTrackResult> {
    const spotifyKey = track.id ? `spotify:${track.id}` : `spotify:${Date.now()}`;
    setResultStatus((prev) => ({ ...prev, [spotifyKey]: "pending" }));
    const response = await submitUrl(track.query, track.artwork_url ?? undefined, track.title ?? null, track.artist ?? null, {
      sourceType: track.sourceType ?? source,
      sourceGenre: track.sourceGenre ?? null,
      sourcePlaylist: track.sourcePlaylist ?? null,
    });
    if (response.status === "manual_select" && response.candidates && response.candidates.length > 0) {
      setResultStatus((prev) => ({ ...prev, [spotifyKey]: "idle" }));
      setPendingManualSelection({
        sourceKey: spotifyKey,
        title: (track.title ?? track.query).trim(),
        artist: track.artist ?? null,
        sourceType: track.sourceType ?? source,
        sourceGenre: track.sourceGenre ?? null,
        sourcePlaylist: track.sourcePlaylist ?? null,
        candidates: response.candidates,
      });
      setFeedback({
        msg: response.message ?? "Geen exacte hit. Kies handmatig een resultaat.",
        ok: false,
      });
      return "manual_select";
    }
    if (!response.ok) {
      setResultStatus((prev) => ({ ...prev, [spotifyKey]: "idle" }));
      return "error";
    }
    setResultStatus((prev) => ({ ...prev, [spotifyKey]: "added" }));
    setTimeout(() => {
      setResultStatus((prev) => ({ ...prev, [spotifyKey]: "idle" }));
    }, 4000);
    startRecentAdd(
      spotifyKey,
      track.query,
      (track.title ?? track.query).trim(),
      track.artist ?? null,
    );
    return "added";
  }

  async function chooseManualCandidate(candidate: QueueAddManualCandidate) {
    if (!pendingManualSelection) return;
    const sourceKey = pendingManualSelection.sourceKey;
    const manualState = pendingManualSelection;
    // Close immediately so UI responds instantly while submit continues.
    setPendingManualSelection(null);

    const result = await submitUrl(
      candidate.url,
      candidate.thumbnail ?? undefined,
      candidate.title,
      candidate.channel,
      {
        sourceType: manualState.sourceType,
        sourceGenre: manualState.sourceGenre,
        sourcePlaylist: manualState.sourcePlaylist,
      },
    );
    if (!result.ok) {
      setResultStatus((prev) => ({ ...prev, [sourceKey]: "idle" }));
      return;
    }
    setResultStatus((prev) => ({ ...prev, [sourceKey]: "added" }));
    startRecentAdd(
      `manual:${Date.now()}`,
      candidate.url,
      candidate.title,
      candidate.channel,
    );
    setTimeout(() => {
      setResultStatus((prev) => ({ ...prev, [sourceKey]: "idle" }));
    }, 4000);
    setFeedback({ msg: "Handmatige keuze toegevoegd aan de wachtrij.", ok: true });
  }

  async function prioritizeGenreArtist(item: GenreHitRow) {
    if (!isAdmin || !activeGenre) return;
    const key = `${activeGenre}:${item.id}`;
    const artist = getPrimaryArtist(item.artist);
    if (!artist) return;
    setGenrePrioritySaving((prev) => ({ ...prev, [key]: true }));
    try {
      await addPriorityArtistToGenre(activeGenre, artist, activeGenreLabel);
      setGenrePrioritySaved((prev) => ({ ...prev, [key]: true }));
      setFeedback({ msg: `Artiest "${artist}" krijgt voortaan voorrang in ${activeGenreLabel}.`, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Kon voorrang artiest niet opslaan.";
      setFeedback({ msg: message, ok: false });
    } finally {
      setGenrePrioritySaving((prev) => ({ ...prev, [key]: false }));
    }
  }

  async function blockGenreArtist(item: GenreHitRow) {
    if (!isAdmin || !activeGenre) return;
    const key = `${activeGenre}:${item.id}`;
    const artist = getPrimaryArtist(item.artist);
    if (!artist) return;
    setGenreBlockSaving((prev) => ({ ...prev, [key]: true }));
    try {
      await blockArtistForGenre(activeGenre, artist, activeGenreLabel);
      setGenreBlockSaved((prev) => ({ ...prev, [key]: true }));
      for (const cacheKey of genreHitsCacheRef.current.keys()) {
        if (cacheKey.startsWith(`${activeGenre.toLowerCase()}::`)) {
          genreHitsCacheRef.current.delete(cacheKey);
        }
      }
      setGenreHits((prev) =>
        prev.filter((row) => getPrimaryArtist(row.artist).toLowerCase() !== artist.toLowerCase()),
      );
      setFeedback({ msg: `Artiest "${artist}" wordt genegeerd in ${activeGenreLabel}.`, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Kon artiest niet blokkeren.";
      setFeedback({ msg: message, ok: false });
    } finally {
      setGenreBlockSaving((prev) => ({ ...prev, [key]: false }));
    }
  }

  return (
    <QueueAddErrorBoundary>
      <div ref={wrapperRef} className="relative z-[100] flex min-h-0 flex-1 flex-col">
      <form onSubmit={handleSubmit} className="relative z-[100] flex min-h-0 flex-1 flex-col gap-2 rounded-xl border border-gray-800 bg-gray-900 p-3 shadow-lg shadow-violet-500/5 sm:p-4">
        <label className="block shrink-0 text-xs font-semibold uppercase tracking-wider text-violet-400">
          Nummer toevoegen
        </label>

        {/* Source tabs */}
        <div className="flex shrink-0 items-center gap-1 rounded-lg bg-gray-800 p-0.5">
          <button
            type="button"
            onClick={() => switchSource("search")}
            className={`group flex h-8 min-w-0 basis-0 items-center justify-center rounded-md px-1.5 text-[11px] font-semibold transition-all duration-200 ${
              source === "search"
                ? "flex-[1.4] bg-violet-500/20 text-violet-300"
                : "flex-1 text-gray-400 hover:text-gray-200"
            }`}
          >
            <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <span
              className={`overflow-hidden whitespace-nowrap transition-all duration-200 ${
                source === "search" ? "ml-1 max-w-[86px] opacity-100" : "max-w-0 opacity-0"
              }`}
            >
              Search
            </span>
          </button>
          <button
            type="button"
            onClick={() => switchSource("video")}
            className={`group relative h-8 min-w-[110px] basis-0 overflow-hidden rounded-md transition-all duration-300 ${
              source === "video"
                ? "flex-[2] bg-gray-800/40 shadow-sm"
                : "flex-1 text-gray-400 hover:text-gray-200"
            }`}
          >
            {/* Background Split */}
            <div 
              className={`absolute inset-0 transition-opacity duration-300 ${
                source === "video" ? "opacity-100" : "opacity-0"
              }`}
              style={{
                background: 'linear-gradient(135deg, rgba(255, 85, 0, 0.2) 50%, rgba(220, 38, 38, 0.2) 50%)'
              }}
            />
            
            <div className="relative flex h-full w-full items-center justify-between px-2.5">
              {/* SC Side */}
              <div className={`flex items-center gap-1 transition-all duration-300 ${source === "video" ? "text-orange-400 translate-y-[-2px] translate-x-[-1px]" : "text-gray-400"}`}>
                <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M1.175 12.225c-.05 0-.075.025-.075.075v4.4c0 .05.025.075.075.075s.075-.025.075-.075v-4.4c0-.05-.025-.075-.075-.075zm-.9.825c-.05 0-.075.025-.075.075v2.75c0 .05.025.075.075.075s.075-.025.075-.075v-2.75c0-.05-.025-.075-.075-.075zm1.8-.6c-.05 0-.075.025-.075.075v5c0 .05.025.075.075.075s.075-.025.075-.075v-5c0-.05-.025-.075-.075-.075zm.9-.75c-.05 0-.075.025-.075.075v6.5c0 .05.025.075.075.075s.075-.025.075-.075v-6.5c0-.05-.025-.075-.075-.075zm.9.275c-.05 0-.075.025-.075.075v5.95c0 .05.025.075.075.075s.075-.025.075-.075v-5.95c0-.05-.025-.075-.075-.075zm.9-.9c-.05 0-.075.025-.075.075v7.75c0 .05.025.075.075.075s.075-.025.075-.075v-7.75c0-.05-.025-.075-.075-.075zm.9 1.05c-.05 0-.075.025-.075.075v5.65c0 .05.025.075.075.075s.075-.025.075-.075v-5.65c0-.05-.025-.075-.075-.075zm.9-2.025c-.05 0-.075.025-.075.075v9.7c0 .05.025.075.075.075s.075-.025.075-.075v-9.7c0-.05-.025-.075-.075-.075zm.9-.475c-.05 0-.075.025-.075.075v10.65c0 .05.025.075.075.075s.075-.025.075-.075V9.55c0-.05-.025-.075-.075-.075zm.9.45c-.05 0-.075.025-.075.075v9.75c0 .05.025.075.075.075s.075-.025.075-.075v-9.75c0-.05-.025-.075-.075-.075zm1.3-.275c-.827 0-1.587.262-2.213.708a5.346 5.346 0 00-1.587-3.658A5.346 5.346 0 009.175 5C6.388 5 4.1 7.163 3.95 9.9c-.013.05-.013.1-.013.15 0 .05 0 .1.013.15h-.175c-.975 0-1.775.8-1.775 1.775v5.05c0 .975.8 1.775 1.775 1.775H12.5c2.375 0 4.3-1.925 4.3-4.3S14.875 10.2 12.5 10.2z" />
                </svg>
                <span className="text-[10px] font-bold">SC</span>
              </div>

              {/* YT Side */}
              <div className={`flex items-center gap-1 transition-all duration-300 ${source === "video" ? "text-red-500 translate-y-[2px] translate-x-[1px]" : "text-gray-400"}`}>
                <span className="text-[10px] font-bold">YT</span>
                <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M23.5 6.2a3.02 3.02 0 00-2.12-2.14C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.38.56A3.02 3.02 0 00.5 6.2 31.7 31.7 0 000 12a31.7 31.7 0 00.5 5.8 3.02 3.02 0 002.12 2.14c1.88.56 9.38.56 9.38.56s7.5 0 9.38-.56a3.02 3.02 0 002.12-2.14A31.7 31.7 0 0024 12a31.7 31.7 0 00-.5-5.8zM9.55 15.5V8.5l6.27 3.5-6.27 3.5z" />
                </svg>
              </div>
            </div>
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
                ? "flex-[1.4] bg-blue-500/20 text-blue-300"
                : "flex-1 text-gray-400 hover:text-gray-200"
            }`}
          >
            <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01" />
            </svg>
            <span
              className={`overflow-hidden whitespace-nowrap transition-all duration-200 ${
                source === "playlists" ? "ml-1 max-w-[86px] opacity-100" : "max-w-0 opacity-0"
              }`}
            >
              Playlists
            </span>
          </button>
          {hasSpotifySource && (
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
                Persoonlijk
              </span>
            </button>
          )}
        </div>

        {source === "spotify" ? (
          <div className="min-h-0 flex-1">
            <SpotifyErrorBoundary onReset={() => switchSource("video")}>
              <SpotifyBrowser onAddTrack={handleSpotifyAdd} submitting={submitting} onSelectFavoriteArtist={(artist) => {
                setSource("search");
                setArtistSearchQuery(artist.name);
                setArtistImageFallback(artist.image_url ?? null);
                setSelectedArtist({
                  id: artist.mbid,
                  name: artist.name,
                  country: null,
                  type: null,
                  disambiguation: null,
                  image: artist.image_url ?? null,
                });
                setArtistTracks([]);
                setArtistAlbums([]);
                setArtistTracksPageSafe(1);
                setArtistTracksHasMore(false);
                setArtistTrackFilter("");
                void loadArtistTracks(artist.name, false);
                void loadArtistArtwork(artist.name);
              }} />
            </SpotifyErrorBoundary>
          </div>
        ) : source === "playlists" ? (
          <div className="min-h-0 flex-1">
            <SharedPlaylistsBrowser onAddTrack={handleSpotifyAdd} submitting={submitting} />
          </div>
        ) : source === "genres" ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
            <div className="shrink-0">
              <input
                type="text"
                value={genreQuery}
                onChange={(e) => {
                  setGenreQuery(e.target.value);
                  if (genreMenuRef.current) genreMenuRef.current.open = true;
                }}
                onFocus={() => {
                  if (genreMenuRef.current) genreMenuRef.current.open = true;
                }}
                placeholder="Zoek genre (hardstyle, trance, rock, metal...)"
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none transition focus:border-fuchsia-500"
              />
            </div>
            <details
              ref={genreMenuRef}
              className="group shrink-0 relative z-20"
              onToggle={() => {
                if (!genreMenuRef.current?.open || !isMobile || !genreSummaryRef.current) {
                  setMobileGenreMenuTop(null);
                  return;
                }
                const rect = genreSummaryRef.current.getBoundingClientRect();
                setMobileGenreMenuTop(Math.max(8, Math.round(rect.bottom + 8)));
              }}
            >
              <summary
                ref={genreSummaryRef}
                className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-gray-700 bg-gray-900/75 px-2.5 py-1.5 text-xs text-gray-200 transition hover:border-violet-500/60"
              >
                <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-semibold text-gray-300">
                  Genre
                </span>
                <span className="min-w-0 truncate text-center text-[12px] font-semibold text-fuchsia-300">
                  {activeGenreLabel}
                </span>
                <span className="justify-self-end text-gray-400 transition group-open:rotate-180">▾</span>
              </summary>
              <div
                className={`${isMobile ? "fixed left-2 right-2 mt-0" : "relative mt-1"} z-[150] overflow-y-auto rounded-md border border-gray-700 bg-gray-900/95 p-1 shadow-lg shadow-black/40 sm:relative sm:mt-1 sm:left-auto sm:right-auto sm:max-h-60`}
                style={
                  isMobile && mobileGenreMenuTop !== null
                    ? { top: mobileGenreMenuTop, maxHeight: `calc(100dvh - ${mobileGenreMenuTop + 8}px)` }
                    : undefined
                }
              >
                <button
                  type="button"
                  onClick={() => {
                    setActiveGenre(null);
                    setGenreHits([]);
                    setGenreOffsetSafe(0);
                    setGenreHasMore(false);
                    genreNoProgressPagesRef.current = 0;
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
            {genresLoading && (
              <p className="shrink-0 text-xs text-gray-400">Genres laden...</p>
            )}
            {genreError && (
              <p className="shrink-0 text-xs text-amber-300">{genreError}</p>
            )}
            {!genresLoading && groupedGenreSections.length === 0 && (
              <p className="shrink-0 text-xs text-gray-400">Geen genres gevonden. Probeer een andere zoekterm.</p>
            )}

            {showGenreHitsPanel && (
              <div
                ref={genreListRef}
                onScroll={handleGenreListScroll}
                className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-gray-800 bg-gray-950/70"
              >
              {genreHitsLoading ? (
                <p className="px-3 py-3 text-xs text-gray-400">Laden...</p>
              ) : genreHits.length === 0 ? (
                <p className="px-3 py-3 text-xs text-gray-400">
                  {activeGenre ? "Geen tracks gevonden voor dit genre." : "Kies een genre om tracks te tonen."}
                </p>
              ) : (
                genreHits.map((item) => (
                  <div key={item.id} className="flex items-start gap-3 border-b border-gray-800/80 px-3 py-2 last:border-b-0">
                    {item.thumbnail ? (
                      <img src={item.thumbnail} alt="" className="h-10 w-10 rounded object-cover" />
                    ) : (
                      <div className="h-10 w-10 rounded bg-gray-800" />
                    )}
                    <div className="min-w-0 flex-1 pr-1">
                      <p className="line-clamp-2 text-sm font-medium leading-snug text-white">{item.title}</p>
                      <p className="truncate text-xs text-gray-400">{item.artist}</p>
                    </div>
                    <div className="ml-auto flex max-w-[50%] shrink-0 flex-col items-end gap-1.5 sm:max-w-none sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
                      {isAdmin && activeGenre && (
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => prioritizeGenreArtist(item)}
                            disabled={genrePrioritySaving[`${activeGenre}:${item.id}`] || genreBlockSaving[`${activeGenre}:${item.id}`]}
                            className={`rounded-md border px-2 py-1 text-[11px] font-semibold transition disabled:opacity-60 ${
                              genrePrioritySaved[`${activeGenre}:${item.id}`]
                                ? "border-emerald-500/70 bg-emerald-500/20 text-emerald-200"
                                : "border-fuchsia-600/70 bg-fuchsia-600/15 text-fuchsia-200 hover:bg-fuchsia-600/25"
                            }`}
                          >
                            {genrePrioritySaving[`${activeGenre}:${item.id}`]
                              ? "Opslaan..."
                              : genrePrioritySaved[`${activeGenre}:${item.id}`]
                                ? "Opgeslagen"
                                : "Voorrang"}
                          </button>
                          <button
                            type="button"
                            onClick={() => blockGenreArtist(item)}
                            disabled={genreBlockSaving[`${activeGenre}:${item.id}`] || genrePrioritySaving[`${activeGenre}:${item.id}`]}
                            className={`rounded-md border px-2 py-1 text-[11px] font-semibold transition disabled:opacity-60 ${
                              genreBlockSaved[`${activeGenre}:${item.id}`]
                                ? "border-rose-500/70 bg-rose-500/20 text-rose-100"
                                : "border-rose-600/70 bg-rose-600/15 text-rose-200 hover:bg-rose-600/25"
                            }`}
                          >
                            {genreBlockSaving[`${activeGenre}:${item.id}`]
                              ? "Blokkeren..."
                              : genreBlockSaved[`${activeGenre}:${item.id}`]
                                ? "Geblokkeerd"
                                : "Negeer"}
                          </button>
                        </div>
                      )}
                      <div className="flex shrink-0 items-center gap-1">
                        <TrackActions 
                          title={item.title} 
                          artist={item.artist} 
                          className="mr-0.5"
                          iconSize={15}
                        />
                      </div>
                    </div>
                  </div>
                ))
              )}
              {genreHitsLoadingMore && (
                <p className="px-3 py-2 text-xs text-gray-400">Meer tracks laden...</p>
              )}
              <div ref={loadMoreRef} className="h-1 w-full" />
              </div>
            )}
          </div>
        ) : source === "search" ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
            {!selectedArtist ? (
              <div className="shrink-0 space-y-2">
                <div className="relative z-10">
                  <div className="flex gap-2">
                    <NoAutofillInput
                      type="search"
                      name={`artist-search-${Math.random().toString(36).substring(7)}`}
                      autoComplete="off"
                      spellCheck={false}
                      value={artistSearchQuery}
                      onChange={(e) => {
                        // Altijd eerst state updaten
                        const val = e.target.value;
                        setArtistSearchQuery(val);
                        if (showFavoriteArtists) setShowFavoriteArtists(false);
                        setSelectedArtist(null);
                        setArtistTracks([]);
                        setArtistAlbums([]);
                        if (debounceRef.current) clearTimeout(debounceRef.current);
                        if (val.length >= 2) {
                          debounceRef.current = setTimeout(() => searchArtists(val), 300);
                        } else {
                          setArtistResults([]);
                          setShowArtistResults(false);
                        }
                      }}
                      onFocus={() => { setShowArtistHistory(true); if (artistResults.length > 0) setShowArtistResults(true); }}
                      onKeyDown={(e) => { if (e.key === 'Escape') { setShowArtistHistory(false); setShowArtistResults(false); } }}
                      onBlur={() => { if (!showArtistResults && !showArtistHistory) return; setTimeout(() => { if (artistSearchQuery.trim() === '') setShowArtistHistory(false); setShowArtistResults(false); }, 150); }}
                      placeholder="Zoek op artiest..."
                      className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 pr-10 text-sm text-white placeholder-gray-500 outline-none transition focus:border-violet-500"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        if (showFavoriteArtists) {
                          setShowFavoriteArtists(false);
                        } else {
                          if (favoriteArtists.length === 0 && !favoriteArtistsLoading) {
                            setFavoriteArtistsLoading(true);
                            try {
                              const favs = await listFavoriteArtists();
                              setFavoriteArtists(favs);
                            } catch (err) {
                              console.error('[QueueAdd] Failed to load favorite artists:', err);
                            } finally {
                              setFavoriteArtistsLoading(false);
                            }
                          }
                          setShowFavoriteArtists(true);
                        }
                      }}
                      className={`shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                        showFavoriteArtists
                          ? 'border-pink-500/50 bg-pink-500/20 text-pink-300'
                          : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-pink-500/50 hover:text-pink-300'
                      }`}
                      title="Favorieten"
                    >
                      <svg className="h-4 w-4" fill={showFavoriteArtists ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                      </svg>
                    </button>
                  </div>
                  {artistSearching && (
                    <div className="absolute right-14 top-1/2 -translate-y-1/2">
                      <span className="block h-4 w-4 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
                    </div>
                  )}
                  {showArtistHistory && artistHistory.length > 0 && (
                    <div className="absolute left-0 right-0 top-full z-40 mt-1 max-h-72 overflow-y-auto overscroll-contain rounded-md border border-gray-700 bg-gray-900 shadow-lg">
                      <div className="px-3 py-1.5 text-[11px] font-medium uppercase text-gray-500">Recente zoekopdrachten</div>
                      {artistHistory.map((h) => (
                        <div key={h.id} className="group flex w-full items-center px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-gray-800">
                          <button
                            type="button"
                            onClick={() => { void selectArtistHistoryItem(h.query); }}
                            className="flex-1 truncate text-left"
                          >
                            {h.query}
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteHistoryItem('artist', h.id)}
                            className="ml-2 shrink-0 px-1 text-red-400 opacity-100 transition hover:text-red-300 sm:opacity-0 sm:group-hover:opacity-100"
                            title="Verwijderen"
                            aria-label={`Verwijder ${h.query} uit geschiedenis`}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {showArtistResults && artistResults.length > 0 && (
                    <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-80 overflow-y-auto overscroll-contain rounded-md border border-gray-700 bg-gray-900 shadow-lg" style={{ WebkitOverflowScrolling: 'touch' }}>
                      {artistResults.map((artist) => {
                        const isFav = isArtistFavorited(artist.id, artist.name);
                        return (
                        <div key={artist.id} className="group flex w-full items-center px-3 py-2 text-left hover:bg-gray-800 first:rounded-t-md last:rounded-b-md">
                          <button
                            type="button"
                            onClick={() => selectArtist(artist)}
                            className="flex min-w-0 flex-1 items-center gap-2"
                          >
                            {artist.image ? (
                              <img src={artist.image} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                            ) : (
                              <div className="h-10 w-10 shrink-0 rounded bg-gray-800" />
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-white">{artist.name}</p>
                              <p className="truncate text-xs text-gray-400">
                                {artist.country || 'Onbekend'}{artist.type ? ` • ${artist.type}` : ''}{artist.disambiguation ? ` • ${artist.disambiguation}` : ''}
                              <input
                                type="text"
                                value={genreQuery}
                                onChange={(e) => {
                                  // Altijd eerst state updaten
                                  const val = e.target.value;
                                  setGenreQuery(val);
                                  if (genreMenuRef.current) genreMenuRef.current.open = true;
                                }}
                                onFocus={() => {
                                  if (genreMenuRef.current) genreMenuRef.current.open = true;
                                }}
                                placeholder="Zoek genre (hardstyle, trance, rock, metal...)"
                                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none transition focus:border-fuchsia-500"
                              />
                            className={`ml-2 shrink-0 rounded p-1 transition ${isFav ? 'text-pink-400 hover:bg-pink-500/10' : 'text-gray-400 hover:bg-pink-500/10 hover:text-pink-400'}`}
                            title={isFav ? "Verwijder uit favorieten" : "Toevoegen aan favorieten"}
                          >
                            <svg className="h-4 w-4" fill={isFav ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                            </svg>
                          </button>
                        </div>
                      );
                      })}
                    </div>
                  )}

                  {showFavoriteArtists && (
                    <div className="mt-2 max-h-72 overflow-y-auto overscroll-contain rounded-md bg-pink-950/10 p-2" style={{ WebkitOverflowScrolling: "touch" }}>
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-[11px] font-semibold text-pink-200">Favoriete artiesten</p>
                        <button
                          type="button"
                          onClick={() => setShowFavoriteArtists(false)}
                          className="text-xs text-pink-300 transition hover:text-pink-200"
                        >
                          Sluiten
                        </button>
                      </div>
                      {favoriteArtistsLoading ? (
                        <div className="flex items-center justify-center py-3">
                          <span className="block h-4 w-4 animate-spin rounded-full border-2 border-pink-400 border-t-transparent" />
                        </div>
                      ) : favoriteArtists.length === 0 ? (
                        <p className="text-xs text-gray-400">Nog geen favorieten. Klik op het hartje naast een artiest om toe te voegen.</p>
                      ) : (
                        <div className="space-y-1">
                          {favoriteArtists.map((artist) => (
                            <div key={artist.mbid} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-pink-500/10">
                              {artist.image_url ? (
                                <img src={artist.image_url} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                              ) : (
                                <div className="h-8 w-8 shrink-0 rounded bg-gray-800" />
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setShowFavoriteArtists(false);
                                  setArtistSearchQuery(artist.name);
                                  setSelectedArtist({
                                    id: artist.mbid,
                                    name: artist.name,
                                    country: artist.country,
                                    type: null,
                                    disambiguation: null,
                                    image: artist.image_url,
                                  });
                                  setArtistTracks([]);
                                  setArtistAlbums([]);
                                  setArtistTracksPageSafe(1);
                                  setArtistTracksHasMore(false);
                                  setArtistTrackFilter("");
                                  void loadArtistTracks(artist.name, false);
                                  void loadArtistArtwork(artist.name);
                                }}
                                className="min-w-0 flex-1 text-left"
                              >
                                <p className="truncate text-xs font-medium text-white">{artist.name}</p>
                                {artist.country && (
                                  <p className="truncate text-[10px] text-gray-400">{artist.country}</p>
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  await removeFavoriteArtist(artist.mbid);
                                  setFavoriteArtists((prev) => prev.filter((f) => f.mbid !== artist.mbid));
                                }}
                                className="shrink-0 rounded p-1 text-gray-500 opacity-0 transition hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                                title="Verwijder uit favorieten"
                              >
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <p className="text-xs text-gray-500">Typ een artiestnaam om nummers te zoeken.</p>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
                <div className="shrink-0 flex items-center justify-between gap-2 px-0.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <button
                      type="button"
                      onClick={() => { setSelectedArtist(null); setArtistSearchQuery(""); setArtistTracks([]); setArtistAlbums([]); setArtistTracksPageSafe(1); setArtistTrackFilter(""); }}
                      className="rounded-md bg-gray-700 p-1.5 text-gray-400 hover:text-white shrink-0"
                    >
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
                    </button>
                    <span className="truncate text-sm font-semibold text-violet-300">{selectedArtist.name}</span>
                    <button
                      type="button"
                      onClick={async () => {
                        await toggleFavoriteArtistState({
                          id: selectedArtist.id,
                          name: selectedArtist.name,
                          image: selectedArtist.image,
                          country: selectedArtist.country,
                        });
                      }}
                      className={`shrink-0 rounded p-1 transition ${isArtistFavorited(selectedArtist.id, selectedArtist.name) ? 'text-pink-400 hover:bg-pink-500/10' : 'text-gray-400 hover:bg-pink-500/10 hover:text-pink-400'}`}
                      title={isArtistFavorited(selectedArtist.id, selectedArtist.name) ? "Verwijder uit favorieten" : "Toevoegen aan favorieten"}
                    >
                      <svg className="h-4 w-4" fill={isArtistFavorited(selectedArtist.id, selectedArtist.name) ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                      </svg>
                    </button>
                  </div>

                  <div className="flex-1 max-w-[180px]">
                    <input
                      type="text"
                      value={artistTrackFilter}
                      onChange={(e) => setArtistTrackFilter(e.target.value)}
                      placeholder="Filter op nummer..."
                      className="w-full rounded-lg border border-gray-700 bg-gray-800/80 px-2 py-1 text-xs text-white placeholder-gray-500 outline-none focus:border-violet-500/50"
                    />
                  </div>
                </div>
                {artistTracksLoading ? (
                  <p className="text-xs text-gray-400 px-1">Laden...</p>
                ) : artistTracks.length === 0 ? (
                  <p className="text-xs text-gray-400 px-1">Geen resultaten gevonden.</p>
                ) : (
                  <div 
                    ref={artistTracksListRef}
                    className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-gray-800 bg-gray-950/70"
                  >
                    {artistTracks
                      .filter(track => !artistTrackFilter || track.name.toLowerCase().includes(artistTrackFilter.toLowerCase()))
                      .map((track, idx) => {
                      const trackId = `${selectedArtist?.id}:${track.rank || idx}`;
                      const isAdded = addedTrackId === trackId;
                      const isPending = pendingTrackId === trackId;
                      
                      const normalizeForMatch = (value: string): string => value
                        .toLowerCase()
                        .replace(/\([^)]*\)/g, " ")
                        .replace(/\[[^\]]*\]/g, " ")
                        .replace(/\b(remix|edit|radio mix|extended mix|live|version)\b/g, " ")
                        .replace(/[^a-z0-9]+/g, " ")
                        .trim();
                      const trackBase = normalizeForMatch(track.name).split(" ").slice(0, 4).join(" ");
                      const matchingAlbum = artistAlbums.find((album) => {
                        const albumBase = normalizeForMatch(album.collectionName);
                        if (!albumBase || !trackBase) return false;
                        return albumBase.includes(trackBase) || trackBase.includes(albumBase);
                      });
                      const thumb = matchingAlbum
                        ? getArtworkUrl(matchingAlbum.artworkUrl100, '300')
                        : (selectedArtist?.image || artistImageFallback || null);

                      return (
                        <div
                          key={trackId}
                          className={`group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition ${
                            isAdded ? "bg-green-500/10" : "hover:bg-gray-800/80"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={async () => {
                              if (isPending || isAdded || !serverUrl) return;
                              setPendingTrackId(trackId);
                              try {
                                const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/downloads/resolve`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({
                                    title: track.name,
                                    artist: track.artist?.name || selectedArtist.name,
                                    source_type: 'search',
                                    source_playlist: null,
                                    source_genre: null,
                                  }),
                                });
                                const payload = await res.json();
                                
                                if (res.ok && payload.item?.url) {
                                  await submitUrl(
                                    payload.item.url,
                                    payload.item.thumbnail ?? thumb ?? undefined,
                                    payload.item.title ?? track.name,
                                    payload.item.artist ?? track.artist?.name ?? selectedArtist.name,
                                    { sourceType: 'search', sourceGenre: null, sourcePlaylist: null }
                                  );
                                  setAddedTrackId(trackId);
                                  setTimeout(() => setAddedTrackId(null), 5000);
                                } else if (payload.candidates && payload.candidates.length > 0) {
                                  setPendingManualSelection({
                                    sourceKey: trackId,
                                    title: track.name,
                                    artist: track.artist?.name || selectedArtist.name,
                                    sourceType: 'search',
                                    sourceGenre: null,
                                    sourcePlaylist: null,
                                    candidates: payload.candidates,
                                  });
                                } else {
                                  setFeedback({ msg: `Geen resultaat gevonden voor "${track.name}".`, ok: false });
                                }
                              } catch (err) {
                                console.error('[search-track] Error:', err);
                                setFeedback({ msg: `Fout bij zoeken voor "${track.name}".`, ok: false });
                              } finally {
                                setPendingTrackId(null);
                              }
                            }}
                            disabled={submitting || isAdded || isPending}
                            className="flex min-w-0 flex-1 items-center gap-2 disabled:opacity-60"
                          >
                            {thumb ? <img src={thumb} alt="" className="h-10 w-10 shrink-0 rounded object-cover" /> : <div className="h-10 w-10 shrink-0 rounded bg-gray-800" />}
                            <div className="min-w-0 flex-1 text-left">
                              <p className="truncate text-xs font-medium text-white">{track.name}</p>
                              <p className="truncate text-[10px] text-gray-400">
                                {`#${track.rank || idx + 1}`}
                                {track.listeners ? ` • ${parseInt(track.listeners).toLocaleString()} luisteraars` : ''}
                              </p>
                            </div>
                            {isAdded ? (
                              <span className="shrink-0 rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-300">
                                Toegevoegd
                              </span>
                            ) : null}
                          </button>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <TrackActions 
                              title={track.name} 
                              artist={track.artist?.name || selectedArtist?.name || ""} 
                              artwork_url={thumb ?? null}
                              className="mr-1"
                              iconSize={16}
                            />
                          </div>
                        </div>
                      );
                    })}
                    {artistTracksLoadingMore && (
                      <p className="px-3 py-2 text-[11px] text-gray-400 animate-pulse">Meer laden...</p>
                    )}
                    <div ref={artistLoadMoreRef} className="h-1 w-full" />
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
         <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
          {/* 1. Zoekveld Sectie */}
          <div className="shrink-0 space-y-2">
            <div className="relative">
              <NoAutofillInput
                type="search"
                name={`search-input-${Math.random().toString(36).substring(7)}`}
                autoComplete="off"
                spellCheck={false}
                value={input}
                onChange={(e) => handleInputChange(e.target.value)}
                onFocus={() => {
                  if (results.length > 0) {
                    setShowResults(true);
                    setShowVideoHistory(false);
                  } else {
                    setShowVideoHistory(true);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setShowVideoHistory(false);
                    setShowResults(false);
                  }
                }}
                onBlur={() => {
                  if (!showResults && !showVideoHistory) return;
                  setTimeout(() => {
                    if (input.trim() === '') setShowVideoHistory(false);
                    setShowResults(false);
                  }, 150);
                }}
                placeholder="Zoek op SoundCloud of YouTube, of plak een link..."
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 pr-40 text-sm text-white placeholder-gray-500 outline-none transition focus:border-violet-500"
              />
              
              <button
                type="button"
                onClick={() => setIncludeSets((prev) => !prev)}
                className={`absolute right-20 top-1/2 -translate-y-1/2 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition ${
                  includeSets
                    ? "border-violet-500/70 bg-violet-500/20 text-violet-200"
                    : "border-gray-600 bg-gray-800/80 text-gray-300 hover:border-gray-500"
                }`}
                aria-pressed={includeSets}
                aria-label="Setjes tonen (langer dan 15 minuten)"
                title="Setjes tonen (> 15 min)"
              >
                Sets tonen
              </button>
              
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
                <div className="absolute right-36 top-1/2 -translate-y-1/2">
                  <span className="block h-4 w-4 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
                </div>
              )}
              
              {/* Zoekarchief / Geschiedenis */}
              {showVideoHistory && videoHistory.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-[250] mt-1 max-h-72 overflow-y-auto overscroll-contain rounded-md border border-gray-700 bg-gray-900 shadow-lg">
                  <div className="px-3 py-1.5 text-[11px] font-medium uppercase text-gray-500">Recente zoekopdrachten</div>
                  {videoHistory.map((h) => (
                    <div key={h.id} className="group flex w-full items-center px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-gray-800">
                      <button
                        type="button"
                        onClick={() => {
                          setInput(h.query);
                          handleInputChange(h.query);
                          setShowVideoHistory(false);
                        }}
                        className="flex-1 truncate text-left"
                      >
                        {h.query}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteHistoryItem('video', h.id)}
                        className="ml-2 shrink-0 px-1 text-red-400 opacity-100 transition hover:text-red-300 sm:opacity-0 sm:group-hover:opacity-100"
                        title="Verwijderen"
                        aria-label={`Verwijder ${h.query} uit geschiedenis`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* 2. Zoekresultaten Lijst */}
              {showResults && results.length > 0 && (
                <div
                  ref={searchListRef}
                  onScroll={handleSearchListScroll}
                  onTouchEnd={handleSearchListTouch}
                  onTouchMove={handleSearchListTouchMove}
                  data-prevent-pull-refresh="1"
                  className="absolute left-0 right-0 top-full z-[300] mt-1 max-h-80 overflow-y-auto overscroll-contain rounded-xl border border-gray-700 bg-gray-900 shadow-2xl shadow-black/50 sm:max-h-96"
                  style={{ 
                    WebkitOverflowScrolling: 'touch',
                    touchAction: 'pan-y'
                  }}
                >
                  {results.map((r) => {
                    const status = resultStatus[`${source}:${r.id}`] ?? "idle";
                    const isAdded = status === "added";
                    const isPending = status === "pending";
                    return (
                    <div
                      key={r.id}
                      className={`group flex w-full items-center gap-2 px-2.5 py-1 text-left transition first:rounded-t-xl last:rounded-b-xl ${
                        isAdded ? "bg-green-500/10" : "hover:bg-gray-800/80"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => selectResult(r)}
                        className="flex min-w-0 flex-1 items-center gap-2"
                      >
                        {r.thumbnail ? (
                          <img
                            src={r.thumbnail}
                            alt=""
                            className="h-8 w-10 shrink-0 rounded object-cover lg:h-7 lg:w-9"
                          />
                        ) : (
                          <div className="flex h-8 w-10 shrink-0 items-center justify-center rounded bg-gray-800 text-[10px] text-gray-500 lg:h-7 lg:w-9">
                            no art
                          </div>
                        )}
                        <div className="min-w-0 flex-1 text-left">
                          <p className="line-clamp-2 text-xs font-medium leading-snug text-white sm:line-clamp-1">{r.title}</p>
                          <div className="mt-0.5 flex items-center gap-2 text-left">
                            {r.channel && (
                              <span className="truncate text-[11px] text-gray-400">{r.channel}</span>
                            )}
                            {r.duration !== null && (
                              <span className="shrink-0 text-[11px] tabular-nums text-gray-500">
                                {formatDuration(r.duration)}
                              </span>
                            )}
                          </div>
                        </div>
                        {isAdded ? (
                          <span className="shrink-0 rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-300">
                            Toegevoegd
                          </span>
                        ) : isPending ? (
                          <span className="shrink-0 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-violet-200">
                            Bezig...
                          </span>
                        ) : null}
                      </button>
                      <TrackActions 
                        title={r.title} 
                        artist={r.channel || ""} 
                        artwork_url={r.thumbnail || null}
                        className="mr-1"
                        iconSize={16}
                      />
                    </div>
                    );
                  })}
                  {searchingMore && (
                    <p className="px-3 py-2 text-[11px] text-gray-400">Meer resultaten laden...</p>
                  )}
                  <div ref={loadMoreRef} className="h-1 w-full" />
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
          </div>
        </div>
      )}

      {feedback && (
        <p className={`text-sm ${feedback.ok ? "text-green-400" : "text-red-400"}`}>
          {feedback.msg}
        </p>
      )}
    </form>

    {/* Handmatige Selectie Modal */}
    {pendingManualSelection && (
      <div className="absolute inset-0 z-[120] flex items-center justify-center bg-black/70 p-2">
        <div className="max-h-[75dvh] w-full max-w-2xl overflow-hidden rounded-xl border border-violet-700/70 bg-gray-950 shadow-2xl shadow-black/60">
          <div className="border-b border-gray-800 px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold text-white">Geen exacte hit gevonden</p>
              <button
                type="button"
                onClick={() => setPendingManualSelection(null)}
                className="rounded border border-gray-700 px-2 py-1 text-[11px] font-semibold text-gray-200 transition hover:border-gray-500 hover:text-white"
              >
                Annuleren
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-300">
              Kies handmatig het juiste resultaat voor{" "}
              <span className="font-semibold text-violet-200">
                {pendingManualSelection.artist
                  ? `${pendingManualSelection.artist} - ${pendingManualSelection.title}`
                  : pendingManualSelection.title}
              </span>.
            </p>
          </div>
          <div className="max-h-[52dvh] overflow-y-auto">
            {pendingManualSelection.candidates.map((candidate) => (
              <button
                key={`${candidate.provider}:${candidate.url}`}
                type="button"
                onClick={() => { void chooseManualCandidate(candidate); }}
                className="flex w-full items-center gap-2 border-b border-gray-900 px-3 py-2 text-left transition hover:bg-gray-900/80"
              >
                {candidate.thumbnail ? (
                  <img src={candidate.thumbnail} alt="" className="h-10 w-12 shrink-0 rounded object-cover" />
                ) : (
                  <div className="h-10 w-12 shrink-0 rounded bg-gray-800" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-white">{candidate.title}</p>
                  <p className="truncate text-xs text-gray-400">{candidate.channel || "Onbekende uploader"}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <TrackActions 
                    title={candidate.title} 
                    artist={candidate.channel} 
                    artwork_url={candidate.thumbnail ?? null}
                    className="mb-1"
                    iconSize={16}
                  />
                  <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] uppercase text-gray-300">
                    {candidate.provider}
                  </span>
                  {candidate.duration !== null && (
                    <span className="text-[11px] tabular-nums text-gray-400">
                      {formatDuration(candidate.duration)}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
          <div className="flex justify-end border-t border-gray-800 px-3 py-2">
            <button
              type="button"
              onClick={() => setPendingManualSelection(null)}
              className="rounded-md border border-gray-700 px-3 py-1 text-xs font-semibold text-gray-200 transition hover:border-gray-500 hover:text-white"
            >
              Annuleren
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Undo Melding */}
    {recentAdd && (
      <div className="pointer-events-none absolute left-0 right-0 top-2 z-[70] px-2">
        <div className="pointer-events-auto flex items-center justify-between gap-2 rounded-lg border border-violet-800/60 bg-violet-950/95 px-3 py-2 text-xs text-violet-100 shadow-lg shadow-violet-900/30 backdrop-blur">
          <span className="min-w-0 flex-1 truncate">
            Toegevoegd: <span className="font-semibold">{recentAdd.title}</span> · {undoSecondsLeft}s
          </span>
          <button
            type="button"
            onClick={undoRecentAdd}
            className="rounded-md border border-violet-600/70 px-2 py-1 font-semibold text-violet-100 transition hover:bg-violet-800/50"
          >
            Ongedaan maken
          </button>
        </div>
      </div>
    )}
  </div>
</QueueAddErrorBoundary>
  );
}
