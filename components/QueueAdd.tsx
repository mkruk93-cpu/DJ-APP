"use client";

import { useState, useEffect, useRef, useCallback, useMemo, Component, type ReactNode } from "react";
import { getSocket } from "@/lib/socket";
import { useRadioStore } from "@/lib/radioStore";
import { canPerformAction } from "@/lib/types";
import { isRadioAdmin, getRadioToken } from "@/lib/auth";
import { isSpotifyConfigured } from "@/lib/spotify";
import { getGenres, getGenreHits, addPriorityArtistToGenre, blockArtistForGenre, type GenreOption, type GenreHit } from "@/lib/radioApi";
import { buildGroupedGenreSections, GENRE_FALLBACK_OPTIONS, getGenreGroupMembers, isGroupedParentGenre, resolveGenreLabel } from "@/lib/genreDropdown";
import SpotifyBrowser from "@/components/SpotifyBrowser";
import SharedPlaylistsBrowser from "@/components/SharedPlaylistsBrowser";

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

type SearchSource = "youtube" | "soundcloud" | "spotify" | "genres" | "playlists";

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

export default function QueueAdd() {
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchingMore, setSearchingMore] = useState(false);
  const [searchOffset, setSearchOffset] = useState(0);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [source, setSource] = useState<SearchSource>("youtube");
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
  const [isMobile, setIsMobile] = useState(false);
  const [mobileGenreMenuTop, setMobileGenreMenuTop] = useState<number | null>(null);
  const mode = useRadioStore((s) => s.mode);
  const queue = useRadioStore((s) => s.queue);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const genreListRef = useRef<HTMLDivElement>(null);
  const genreMenuRef = useRef<HTMLDetailsElement>(null);
  const genreSummaryRef = useRef<HTMLElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const searchListRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentAddTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentAddTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const genreLoadInFlightRef = useRef(false);
  const genreNoProgressPagesRef = useRef(0);
  const genreHitsCacheRef = useRef(new Map<string, GenreHit[]>());
  const searchOffsetRef = useRef(0);
  const genreOffsetRef = useRef(0);
  const latestSearchRunRef = useRef(0);
  const GENRE_PAGE_SIZE = 10;
  const SEARCH_PAGE_SIZE = 12;

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

  const serverUrl = useRadioStore((s) => s.serverUrl) ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL;
  const isAdmin = hydrated && isRadioAdmin();
  const canAdd = canPerformAction(mode, "add_to_queue", isAdmin);
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
    return typeof window !== "undefined"
      ? localStorage.getItem("nickname") ?? "anonymous"
      : "anonymous";
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

    const offset = append ? searchOffsetRef.current : 0;
    const runId = ++latestSearchRunRef.current;
    if (append) setSearchingMore(true);
    else setSearching(true);
    fetch(
      `${serverUrl}/search?q=${encodeURIComponent(query)}&source=${source}&limit=${SEARCH_PAGE_SIZE}&offset=${offset}&includeLocal=${includeLocal ? "1" : "0"}`,
    )
      .then((r) => r.json())
      .then((data: SearchResult[]) => {
        if (runId !== latestSearchRunRef.current) return;
        const normalized = Array.isArray(data) ? data : [];
        const visible = filterSetResults(normalized);
        setResults((prev) => {
          if (!append) return visible;
          const merged = [...prev, ...visible];
          return Array.from(new Map(merged.map((item) => [item.id, item])).values());
        });
        setSearchQuery(query);
        setSearchOffsetSafe(offset + normalized.length);
        
        // Improved logic for hasMore when local files are included
        if (includeLocal && offset < 30) {
          // When local files are enabled, always assume more results until offset 30
          // This ensures we can reach remote results after local bucket (20) + buffer
          console.log('[search-debug] Setting hasMore=true (includeLocal, offset < 30)', { offset, includeLocal });
          setSearchHasMore(true);
        } else {
          // Standard logic: has more if we got results
          const hasMore = normalized.length > 0;
          console.log('[search-debug] Setting hasMore based on results', { hasMore, resultsLength: normalized.length, offset });
          setSearchHasMore(hasMore);
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
          // On error during append, still allow more attempts if we're in local+remote mode
          if (includeLocal && searchOffsetRef.current < 30) {
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
  }, [serverUrl, source, includeSets, includeLocal]);

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

  // Calculate dropdown position to prevent it from going off-screen
  const calculateDropdownPosition = useCallback(() => {
    if (typeof window === 'undefined' || !wrapperRef.current) return;

    const inputContainer = wrapperRef.current.querySelector('input[type="text"]')?.parentElement;
    if (!inputContainer) return;

    const rect = inputContainer.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;

    // Mobile: always stretch the results list to the bottom viewport edge.
    // This avoids the empty strip under the list on phones.
    if (isMobile) {
      const top = Math.min(Math.max(8, Math.round(rect.bottom + 8)), Math.max(8, viewportHeight - 140));
      const maxHeight = Math.max(120, viewportHeight - top - 8);
      setDropdownStyle({
        position: 'fixed',
        left: '8px',
        right: '8px',
        top: `${top}px`,
        bottom: '8px',
        marginTop: '0',
        transform: 'none',
        maxHeight: `${maxHeight}px`,
      });
      return;
    }
    
    // Check if we have enough space below (need at least 200px for meaningful dropdown)
    if (spaceBelow >= 200) {
      // Position normally below input
      setDropdownStyle({
        maxHeight: `${Math.max(140, spaceBelow - 8)}px`
      });
    } else if (spaceAbove >= 200) {
      // Position above input if more space there
      setDropdownStyle({
        bottom: '100%',
        top: 'auto',
        marginBottom: '4px',
        marginTop: '0',
        maxHeight: `${Math.max(140, spaceAbove - 8)}px`
      });
    } else {
      // Use fixed positioning in center if neither has enough space
      setDropdownStyle({
        position: 'fixed',
        left: '8px',
        right: '8px',
        top: '50%',
        transform: 'translateY(-50%)',
        maxHeight: `${viewportHeight * 0.6}px`
      });
    }
  }, [isMobile]);

  // Update dropdown position when results are shown
  useEffect(() => {
    if (showResults && results.length > 0) {
      calculateDropdownPosition();
      
      // Recalculate on window resize
      const handleResize = () => calculateDropdownPosition();
      window.addEventListener('resize', handleResize);
      
      return () => window.removeEventListener('resize', handleResize);
    }
  }, [showResults, results.length, calculateDropdownPosition]);

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
    if (source !== "genres" || !activeGenre) return;
    setGenreHits([]);
    setGenreOffsetSafe(0);
    setGenreHasMore(false);
    genreNoProgressPagesRef.current = 0;
    loadGenreHits(activeGenre, false);
  }, [includeLocal]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setInput(value);
    setFeedback(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (isSupportedUrl(value.trim())) {
      setResults([]);
      setSearchOffsetSafe(0);
      setSearchHasMore(false);
      setSearchQuery("");
      setShowResults(false);
      return;
    }

    const query = value.trim();
    if (query.length >= 2) {
      debounceRef.current = setTimeout(() => search(query, false), 260);
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
  ) {
    setSubmitting(true);
    if (!options?.keepResults) setShowResults(false);

    const nickname =
      typeof window !== "undefined"
        ? localStorage.getItem("nickname") ?? "anonymous"
        : "anonymous";

    const socket = getSocket();

    function onError(data: { message: string }) {
      showFeedback(data.message, false);
      if (!options?.keepInput) setInput("");
      options?.onError?.();
      cleanup();
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
    });

    // Do not block consecutive submissions while server validates this one.
    setSubmitting(false);
    if (!options?.keepInput) setInput("");

    setTimeout(() => {
      cleanup();
    }, 10_000);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (source === "spotify" || source === "genres" || source === "playlists") return;
    const trimmed = input.trim();

    if (!isSupportedUrl(trimmed)) {
      if (results.length > 0) {
        selectResult(results[0]);
      } else {
        setFeedback({ msg: "Zoek een nummer of plak een YouTube/SoundCloud link.", ok: false });
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
        setSearching(true);
        const url = serverUrl ?? "";
        fetch(`${url}/search?q=${encodeURIComponent(query)}&source=${newSource}&limit=${SEARCH_PAGE_SIZE}&offset=0&includeLocal=${includeLocal ? "1" : "0"}`)
          .then((r) => r.json())
          .then((data: SearchResult[]) => {
            const normalized = Array.isArray(data) ? data : [];
            setResults(filterSetResults(normalized));
            setSearchOffsetSafe(normalized.length);
            setSearchHasMore(normalized.length > 0);
            setSearchQuery(query);
            setShowResults(filterSetResults(normalized).length > 0);
          })
          .catch(() => setResults([]))
          .finally(() => setSearching(false));
      }, 100);
    }
  }

  function handleSpotifyAdd(track: {
    id?: string;
    query: string;
    artist?: string | null;
    title?: string | null;
    sourceType?: string | null;
    sourceGenre?: string | null;
    sourcePlaylist?: string | null;
  }) {
    const spotifyKey = track.id ? `spotify:${track.id}` : `spotify:${Date.now()}`;
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
    submitUrl(track.query, undefined, track.title ?? null, track.artist ?? null, {
      sourceType: track.sourceType ?? source,
      sourceGenre: track.sourceGenre ?? null,
      sourcePlaylist: track.sourcePlaylist ?? null,
    });
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
      <div ref={wrapperRef} className="relative z-[90] overflow-visible">
      <form onSubmit={handleSubmit} className="relative z-[90] space-y-2 overflow-visible rounded-xl border border-gray-800 bg-gray-900 p-3 shadow-lg shadow-violet-500/5 sm:p-4">
        <label className="block text-xs font-semibold uppercase tracking-wider text-violet-400">
          Nummer toevoegen
        </label>

        {/* Source tabs */}
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
                Spotify
              </span>
            </button>
          )}
        </div>

        {source === "spotify" ? (
          <SpotifyErrorBoundary onReset={() => switchSource("youtube")}>
            <SpotifyBrowser onAddTrack={handleSpotifyAdd} submitting={submitting} />
          </SpotifyErrorBoundary>
        ) : source === "playlists" ? (
          <SharedPlaylistsBrowser onAddTrack={handleSpotifyAdd} submitting={submitting} />
        ) : source === "genres" ? (
          <div className="flex min-h-0 flex-col gap-2">
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
            <details
              ref={genreMenuRef}
              className="group relative z-20"
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
                className={`${isMobile ? "fixed left-2 right-2 mt-0" : "relative mt-1"} z-30 overflow-y-auto rounded-md border border-gray-700 bg-gray-900/95 p-1 shadow-lg shadow-black/40 sm:relative sm:mt-1 sm:left-auto sm:right-auto sm:max-h-60`}
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
              <p className="text-xs text-gray-400">Genres laden...</p>
            )}
            {genreError && (
              <p className="text-xs text-amber-300">{genreError}</p>
            )}
            {!genresLoading && groupedGenreSections.length === 0 && (
              <p className="text-xs text-gray-400">Geen genres gevonden. Probeer een andere zoekterm.</p>
            )}

            {showGenreHitsPanel && (
              <div
                ref={genreListRef}
                onScroll={handleGenreListScroll}
                className="min-h-[14rem] max-h-[70dvh] overflow-y-auto rounded-lg border border-gray-800 bg-gray-950/70"
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
                      <button
                        type="button"
                        onClick={() => {
                          const key = `genres:${item.id}`;
                          setResultStatus((prev) => ({ ...prev, [key]: "pending" }));
                          setTimeout(() => {
                            setResultStatus((prev) => ({ ...prev, [key]: "added" }));
                          }, 120);
                          setTimeout(() => {
                            setResultStatus((prev) => ({ ...prev, [key]: "idle" }));
                          }, 4000);
                          const localOrQuery = item.sourceHint?.startsWith("local://") ? item.sourceHint : item.query;
                          startRecentAdd(key, localOrQuery, item.title, item.artist);
                          submitUrl(localOrQuery, item.thumbnail || undefined, item.title, item.artist, {
                            sourceType: "genres",
                            sourceGenre: activeGenreLabel,
                          });
                        }}
                        disabled={submitting}
                        className={`rounded-md px-2.5 py-1 text-xs font-semibold text-white transition disabled:opacity-50 ${
                          resultStatus[`genres:${item.id}`] === "added"
                            ? "bg-green-600 hover:bg-green-500"
                            : resultStatus[`genres:${item.id}`] === "pending"
                              ? "bg-violet-500/80"
                              : "bg-violet-600 hover:bg-violet-500"
                        }`}
                      >
                        {resultStatus[`genres:${item.id}`] === "added"
                          ? "Toegevoegd"
                          : resultStatus[`genres:${item.id}`] === "pending"
                            ? "Bezig..."
                            : "Toevoegen"}
                      </button>
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
              {searching && (
                <div className="absolute right-36 top-1/2 -translate-y-1/2">
                  <span className="block h-4 w-4 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
                </div>
              )}
              {showResults && results.length > 0 && (
                <div
                  ref={searchListRef}
                  onScroll={handleSearchListScroll}
                  onTouchEnd={handleSearchListTouch}
                  onTouchMove={handleSearchListTouchMove}
                  className="absolute left-0 right-0 top-full z-[95] mt-1 overflow-y-auto rounded-xl border border-gray-700 bg-gray-900 shadow-2xl shadow-black/50"
                  style={{ 
                    WebkitOverflowScrolling: 'touch',
                    transform: 'translateZ(0)', // Force hardware acceleration
                    willChange: 'scroll-position', // Optimize for scrolling
                    touchAction: 'pan-y', // Allow vertical scrolling only
                    ...dropdownStyle // Apply calculated positioning
                  }}
                >
                  {results.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => selectResult(r)}
                      className="flex w-full items-center gap-2 px-2.5 py-1 text-left transition hover:bg-gray-800/80 first:rounded-t-xl last:rounded-b-xl"
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
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-xs font-medium leading-snug text-white sm:line-clamp-1">{r.title}</p>
                        <div className="mt-0.5 flex items-center gap-2">
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
                      {resultStatus[`${source}:${r.id}`] === "added" && (
                        <span className="shrink-0 rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-300">
                          Toegevoegd
                        </span>
                      )}
                      {resultStatus[`${source}:${r.id}`] === "pending" && (
                        <span className="shrink-0 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-violet-300">
                          Bezig...
                        </span>
                      )}
                      {r.duration !== null && r.duration > 3900 && (
                        <span className="shrink-0 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-red-400">
                          Te lang
                        </span>
                      )}
                    </button>
                  ))}
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
          </>
        )}
        {feedback && (
          <p className={`text-sm ${feedback.ok ? "text-green-400" : "text-red-400"}`}>
            {feedback.msg}
          </p>
        )}
      </form>

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
