import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Rnd } from "react-rnd";
import type {
  ChatMessage,
  NowPlaying,
  OverlaySettings,
  PanelLayout,
  PollPreset,
  RequestItem,
} from "./types";
import {
  loadChatLayout,
  loadPollPresets,
  loadRequestLayout,
  loadSettings,
  saveChatLayout,
  savePollPresets,
  saveRequestLayout,
  saveSettings,
} from "./lib/storage";
import { fetchRequests, updateRequestStatus } from "./lib/api";
import { matchesNowPlaying } from "./lib/match";

declare global {
  interface Window {
    overlayHost?: {
      setClickThrough: (enabled: boolean) => void;
    };
  }
}

const MAX_CHAT = 200;
const GENRE_OPTION_CHIPS = [
  "⚡ Hardstyle",
  "🔊 Hardcore",
  "💣 Uptempo",
  "🥁 Frenchcore",
  "💥 Krach",
  "🖤 Techno",
  "🌌 Trance",
  "🎧 EDM",
];
const DEFAULT_POLL_TEMPLATES: Array<{ name: string; question: string; options: string[] }> = [
  {
    name: "Genre keuze",
    question: "Welk genre wil je nu horen?",
    options: ["⚡ Hardstyle", "🔊 Hardcore", "🥁 Frenchcore", "💥 Krach"],
  },
  {
    name: "Vibe check",
    question: "Welke vibe gaan we nu doen?",
    options: ["🔥 Keihard", "🎶 Chill", "⚡ Verras me"],
  },
  {
    name: "Volgende stap",
    question: "Wat wil je als volgende?",
    options: ["🚀 Nieuw nummer", "💿 Klassieker", "🎤 Meezinger"],
  },
];

function timeStr(iso: string): string {
  return new Date(iso).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
}

interface OverlaySearchResult {
  id: string;
  title: string;
  url: string;
  thumbnail?: string;
  channel?: string;
  duration?: number | null;
}

interface LivePollState {
  id: string;
  question: string;
  options: string[];
  counts: number[];
  totalVotes: number;
}

function formatDuration(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function scoreSearchResult(item: OverlaySearchResult): number {
  const title = (item.title ?? "").toLowerCase();
  let score = 0;
  if (item.duration && item.duration > 0) {
    // Prefer normal tracks over long sets.
    if (item.duration <= 8 * 60) score += 40;
    else if (item.duration <= 12 * 60) score += 24;
    else if (item.duration <= 20 * 60) score += 8;
    else score -= 30;
  }
  if (/\b(set|mix|liveset|live set|hour|hours|full set|podcast|radio)\b/i.test(title)) score -= 35;
  if (/\b(official|audio|video|track)\b/i.test(title)) score += 6;
  return score;
}

function joinBase(base: string, path: string): string {
  const trimmed = (base ?? "").trim();
  if (!trimmed || trimmed === "/") return path;
  return `${trimmed.replace(/\/+$/, "")}${path}`;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function parsePollOptions(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(",")) {
    const opt = raw.trim();
    if (!opt) continue;
    const key = opt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(opt);
  }
  return out;
}

function optionsToInput(options: string[]): string {
  return options.join(", ");
}

function createPresetId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `preset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function App() {
  const nickname =
    typeof window !== "undefined"
      ? localStorage.getItem("nickname") ?? "anon"
      : "anon";
  const [settings, setSettings] = useState<OverlaySettings>(() => {
    const base = loadSettings();
    const runsOverHttp = typeof window !== "undefined" && window.location.protocol.startsWith("http");
    const defaultApiBase = runsOverHttp ? "/" : "http://localhost:3000";
    return {
      ...base,
      apiBaseUrl: base.apiBaseUrl || defaultApiBase,
      controlServerUrl: base.controlServerUrl || (import.meta.env.VITE_CONTROL_SERVER_URL ?? "http://localhost:3001"),
      adminToken: base.adminToken || (import.meta.env.VITE_OVERLAY_ADMIN_TOKEN ?? ""),
      supabaseUrl: base.supabaseUrl || (import.meta.env.VITE_SUPABASE_URL ?? ""),
      supabaseAnonKey: base.supabaseAnonKey || (import.meta.env.VITE_SUPABASE_ANON_KEY ?? ""),
      lockLayout: false,
      clickThrough: false,
    };
  });
  const [chatLayout, setChatLayout] = useState<PanelLayout>(() => loadChatLayout());
  const [requestLayout, setRequestLayout] = useState<PanelLayout>(() => loadRequestLayout());
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nowPlaying, setNowPlaying] = useState<NowPlaying>({
    title: null,
    artist: null,
    artwork_url: null,
  });
  const [resolvedIds, setResolvedIds] = useState<Record<string, string>>({});
  const [lastError, setLastError] = useState<string>("");
  const [connectionText, setConnectionText] = useState("Connecting...");
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const clickThroughRef = useRef<boolean | null>(null);
  const [sessionStartedAt] = useState<string>(() => new Date().toISOString());
  const [onlineUsers, setOnlineUsers] = useState<string[]>([]);
  const [onlineExpanded, setOnlineExpanded] = useState(false);
  const [activeTool, setActiveTool] = useState<"none" | "search" | "poll" | "shoutout">("none");
  const [searchSource, setSearchSource] = useState<"youtube" | "soundcloud">("youtube");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<OverlaySearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [addingRequest, setAddingRequest] = useState(false);
  const [autoApproveOnAdd, setAutoApproveOnAdd] = useState(true);
  const [searchFeedback, setSearchFeedback] = useState<string>("");
  const [activePoll, setActivePoll] = useState<LivePollState | null>(null);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptionsInput, setPollOptionsInput] = useState("🔥 Keihard, 🎶 Chill, ⚡ Verras me");
  const [pollFeedback, setPollFeedback] = useState("");
  const [pollPresets, setPollPresets] = useState<PollPreset[]>(() => loadPollPresets());
  const [pollPresetName, setPollPresetName] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [shoutoutMessage, setShoutoutMessage] = useState("");
  const [shoutoutFeedback, setShoutoutFeedback] = useState("");
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);

  const supabase: SupabaseClient | null = useMemo(() => {
    if (!settings.supabaseUrl || !settings.supabaseAnonKey) return null;
    try {
      return createClient(settings.supabaseUrl, settings.supabaseAnonKey);
    } catch {
      return null;
    }
  }, [settings.supabaseUrl, settings.supabaseAnonKey]);

  const openRequests = useMemo(() => {
    return requests.filter(
      (r) => {
        const requestTs = Date.parse(r.created_at ?? "");
        const sessionTs = Date.parse(sessionStartedAt);
        const isFromThisSession =
          Number.isFinite(requestTs) && Number.isFinite(sessionTs) ? requestTs >= sessionTs : false;
        return (
          isFromThisSession &&
          (r.status === "pending" || r.status === "approved" || r.status === "downloaded") &&
          !resolvedIds[r.id]
        );
      },
    );
  }, [requests, resolvedIds, sessionStartedAt]);

  const selectedRequest = useMemo(
    () => openRequests.find((r) => r.id === selectedId) ?? openRequests[0] ?? null,
    [openRequests, selectedId],
  );

  async function refreshRequests() {
    try {
      const items = await fetchRequests(settings.apiBaseUrl);
      setRequests(items);
      setConnectionText("Connected");
      setLastError("");
    } catch (err) {
      if (supabase) {
        const { data, error } = await supabase
          .from("requests")
          .select("id,nickname,url,title,artist,thumbnail,duration,source,genre,genre_confidence,status,created_at")
          .order("created_at", { ascending: false })
          .limit(50);
        if (!error) {
          setRequests((data ?? []) as RequestItem[]);
          setConnectionText("Connected (fallback)");
          setLastError("");
          return;
        }
      }
      setConnectionText("Disconnected");
      setLastError(err instanceof Error ? err.message : "Request fetch failed");
    }
  }

  async function changeStatus(id: string, status: RequestItem["status"]) {
    try {
      await updateRequestStatus(settings.apiBaseUrl, settings.adminToken, id, status);
      await refreshRequests();
      if (status !== "pending" && status !== "approved") {
        setResolvedIds((prev) => ({ ...prev, [id]: new Date().toISOString() }));
      }
    } catch (err) {
      if (supabase) {
        const { error } = await supabase.from("requests").update({ status }).eq("id", id);
        if (!error) {
          await refreshRequests();
          if (status !== "pending" && status !== "approved") {
            setResolvedIds((prev) => ({ ...prev, [id]: new Date().toISOString() }));
          }
          setConnectionText("Connected (fallback)");
          setLastError("");
          return;
        }
      }
      setLastError(err instanceof Error ? err.message : "Status update failed");
    }
  }

  async function runSearch(query: string, source: "youtube" | "soundcloud") {
    const q = query.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    const base = (settings.controlServerUrl ?? "").trim();
    if (!base) {
      setSearchFeedback("Control server URL ontbreekt.");
      return;
    }

    setSearching(true);
    setSearchFeedback("");
    try {
      const res = await fetch(`${base.replace(/\/+$/, "")}/search?q=${encodeURIComponent(q)}&source=${source}`);
      if (!res.ok) throw new Error(`search failed (${res.status})`);
      const payload = (await res.json()) as OverlaySearchResult[];
      const normalized = (payload ?? []).slice();
      normalized.sort((a, b) => scoreSearchResult(b) - scoreSearchResult(a));
      setSearchResults(normalized);
    } catch (err) {
      setSearchResults([]);
      setSearchFeedback(err instanceof Error ? err.message : "Zoeken mislukt");
    } finally {
      setSearching(false);
    }
  }

  async function addSearchResult(item: OverlaySearchResult) {
    const nickname =
      (typeof window !== "undefined" && localStorage.getItem("nickname")) ||
      "DJ";

    setAddingRequest(true);
    setSearchFeedback("");
    try {
      const body = JSON.stringify({
        nickname,
        url: item.url,
        title: item.title ?? null,
        artist: item.channel ?? null,
        thumbnail: item.thumbnail ?? null,
        duration: item.duration ?? null,
        source: searchSource,
      });
      const candidates = [
        joinBase(settings.apiBaseUrl, "/api/requests"),
        "http://localhost:3000/api/requests",
        "http://localhost:3002/api/requests",
        "http://localhost:3003/api/requests",
      ];
      let createdId = "";
      let created = false;
      let lastErr = "Request toevoegen mislukt";

      for (const url of candidates) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          const payload = (await res.json().catch(() => ({}))) as { error?: string; item?: { id?: string } };
          if (!res.ok) {
            lastErr = payload.error ?? `Request toevoegen mislukt (${res.status})`;
            continue;
          }
          createdId = payload.item?.id ?? "";
          created = true;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : "Request toevoegen mislukt";
        }
      }

      if (!created) {
        // Last-resort fallback: direct insert via Supabase (keeps overlay usable even if Next API base is unreachable).
        if (supabase) {
          const fallbackStatus = autoApproveOnAdd ? "approved" : "pending";
          let insertResult = await supabase
            .from("requests")
            .insert({
              nickname,
              url: item.url,
              title: item.title ?? null,
              artist: item.channel ?? null,
              thumbnail: item.thumbnail ?? null,
              duration: item.duration ?? null,
              source: searchSource,
              status: fallbackStatus,
            })
            .select("id")
            .single();

          if (insertResult.error && /duration/i.test(insertResult.error.message)) {
            insertResult = await supabase
              .from("requests")
              .insert({
                nickname,
                url: item.url,
                title: item.title ?? null,
                artist: item.channel ?? null,
                thumbnail: item.thumbnail ?? null,
                source: searchSource,
                status: fallbackStatus,
              })
              .select("id")
              .single();
          }

          if (insertResult.error) {
            throw new Error(insertResult.error.message || lastErr);
          }
          createdId = insertResult.data?.id ?? "";
          created = true;
        } else {
          throw new Error(lastErr);
        }
      }

      if (autoApproveOnAdd && createdId && settings.adminToken) {
        await updateRequestStatus(settings.apiBaseUrl, settings.adminToken, createdId, "approved");
      }

      await refreshRequests();
      setSearchFeedback(autoApproveOnAdd ? "Toegevoegd en direct geaccepteerd." : "Toegevoegd aan verzoekjes.");
      setSearchQuery("");
      setSearchResults([]);
    } catch (err) {
      setSearchFeedback(err instanceof Error ? err.message : "Toevoegen mislukt");
    } finally {
      setAddingRequest(false);
    }
  }

  async function refreshLivePoll() {
    const runsOverHttp = typeof window !== "undefined" && window.location.protocol.startsWith("http");
    const candidates = uniqueStrings([
      runsOverHttp ? "/api/live-polls" : "",
      joinBase(settings.apiBaseUrl, "/api/live-polls"),
      "http://localhost:3000/api/live-polls",
      "http://localhost:3002/api/live-polls",
      "http://localhost:3003/api/live-polls",
    ]);
    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) continue;
        const data = (await res.json().catch(() => ({}))) as { poll?: LivePollState | null };
        setActivePoll(data.poll ?? null);
        return;
      } catch {
        // Try next candidate.
      }
    }
    setActivePoll(null);
  }

  async function createLivePoll() {
    const question = pollQuestion.trim();
    const options = parsePollOptions(pollOptionsInput);
    if (!question || options.length < 2) {
      setPollFeedback("Vul een vraag + minimaal 2 opties in.");
      return;
    }
    const runsOverHttp = typeof window !== "undefined" && window.location.protocol.startsWith("http");
    const candidates = uniqueStrings([
      runsOverHttp ? "/api/live-polls" : "",
      joinBase(settings.apiBaseUrl, "/api/live-polls"),
      "http://localhost:3000/api/live-polls",
      "http://localhost:3002/api/live-polls",
      "http://localhost:3003/api/live-polls",
    ]);
    let lastError = "Poll starten mislukt";
    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-token": settings.adminToken },
          body: JSON.stringify({ question, options }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          lastError = data.error ?? `Poll starten mislukt (${res.status})`;
          continue;
        }
        setPollFeedback("Live poll gestart.");
        setPollQuestion("");
        await refreshLivePoll();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : "Poll starten mislukt";
      }
    }
    setPollFeedback(lastError);
  }

  async function closeLivePoll() {
    if (!activePoll) return;
    const runsOverHttp = typeof window !== "undefined" && window.location.protocol.startsWith("http");
    const candidates = uniqueStrings([
      runsOverHttp ? `/api/live-polls/${activePoll.id}` : "",
      joinBase(settings.apiBaseUrl, `/api/live-polls/${activePoll.id}`),
      `http://localhost:3000/api/live-polls/${activePoll.id}`,
      `http://localhost:3002/api/live-polls/${activePoll.id}`,
      `http://localhost:3003/api/live-polls/${activePoll.id}`,
    ]);
    let lastError = "Poll sluiten mislukt";
    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "x-admin-token": settings.adminToken },
          body: JSON.stringify({ status: "closed" }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          lastError = data.error ?? `Poll sluiten mislukt (${res.status})`;
          continue;
        }
        setPollFeedback("Poll gesloten.");
        await refreshLivePoll();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : "Poll sluiten mislukt";
      }
    }
    setPollFeedback(lastError);
  }

  async function sendShoutout(targetNickname?: string) {
    const nick = (targetNickname ?? selectedRequest?.nickname ?? "").trim();
    const msg = shoutoutMessage.trim();
    if (!nick || !msg) {
      setShoutoutFeedback("Kies een nickname en vul een bericht in.");
      return;
    }
    const runsOverHttp = typeof window !== "undefined" && window.location.protocol.startsWith("http");
    const candidates = uniqueStrings([
      runsOverHttp ? "/api/shoutouts" : "",
      joinBase(settings.apiBaseUrl, "/api/shoutouts"),
      "http://localhost:3000/api/shoutouts",
      "http://localhost:3002/api/shoutouts",
      "http://localhost:3003/api/shoutouts",
    ]);
    let lastError = "Shoutout mislukt";
    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-token": settings.adminToken },
          body: JSON.stringify({ nickname: nick, message: msg, durationSeconds: 18 }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          lastError = data.error ?? `Shoutout mislukt (${res.status})`;
          continue;
        }
        setShoutoutFeedback(`Shoutout live voor ${nick}`);
        setShoutoutMessage("");
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : "Shoutout mislukt";
      }
    }
    setShoutoutFeedback(lastError);
  }

  function applyPollTemplate(question: string, options: string[]) {
    setPollQuestion(question);
    setPollOptionsInput(optionsToInput(options));
    setPollFeedback("");
  }

  function toggleGenreOption(option: string) {
    const current = parsePollOptions(pollOptionsInput);
    const has = current.some((item) => item.toLowerCase() === option.toLowerCase());
    const next = has
      ? current.filter((item) => item.toLowerCase() !== option.toLowerCase())
      : [...current, option];
    setPollOptionsInput(optionsToInput(next));
  }

  function saveCurrentPollPreset() {
    const question = pollQuestion.trim();
    const options = parsePollOptions(pollOptionsInput);
    const name = pollPresetName.trim();
    if (!name || !question || options.length < 2) {
      setPollFeedback("Preset opslaan: vul naam, vraag en minimaal 2 opties in.");
      return;
    }
    const preset: PollPreset = {
      id: createPresetId(),
      name,
      question,
      options,
      created_at: new Date().toISOString(),
    };
    setPollPresets((prev) => [preset, ...prev].slice(0, 50));
    setSelectedPresetId(preset.id);
    setPollPresetName("");
    setPollFeedback(`Preset opgeslagen: ${name}`);
  }

  function loadSelectedPollPreset() {
    const preset = pollPresets.find((p) => p.id === selectedPresetId);
    if (!preset) return;
    applyPollTemplate(preset.question, preset.options);
    setPollFeedback(`Preset geladen: ${preset.name}`);
  }

  function removeSelectedPollPreset() {
    const preset = pollPresets.find((p) => p.id === selectedPresetId);
    if (!preset) return;
    setPollPresets((prev) => prev.filter((p) => p.id !== selectedPresetId));
    setSelectedPresetId("");
    setPollFeedback(`Preset verwijderd: ${preset.name}`);
  }

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    function applyClickThrough(enabled: boolean) {
      if (clickThroughRef.current === enabled) return;
      clickThroughRef.current = enabled;
      window.overlayHost?.setClickThrough(enabled);
    }

    if (settings.clickThrough) {
      applyClickThrough(true);
      return;
    }

    // Smart passthrough: interactive panels remain clickable, transparent regions click through.
    const onMouseMove = (e: MouseEvent) => {
      const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const isInteractive = !!target?.closest('[data-overlay-interactive="true"]');
      applyClickThrough(!isInteractive);
    };

    applyClickThrough(true);
    window.addEventListener("mousemove", onMouseMove);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      applyClickThrough(false);
    };
  }, [settings.clickThrough]);

  useEffect(() => {
    if (!settings.apiBaseUrl) return;
    if (settings.supabaseUrl && settings.supabaseAnonKey) return;

    const base = settings.apiBaseUrl.trim();
    const primary =
      !base || base === "/"
        ? "/api/overlay-config"
        : `${base.replace(/\/+$/, "")}/api/overlay-config`;
    const candidates = [primary, "http://localhost:3000/api/overlay-config"];

    (async () => {
      for (const url of candidates) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const cfg = (await res.json()) as {
            supabaseUrl?: string;
            supabaseAnonKey?: string;
            controlServerUrl?: string;
          };
          const resolvedBase = url.startsWith("http://localhost:3000") ? "http://localhost:3000" : "/";
          const runsOverHttp = window.location.protocol.startsWith("http");
          setSettings((prev) => ({
            ...prev,
            supabaseUrl: prev.supabaseUrl || cfg.supabaseUrl || "",
            supabaseAnonKey: prev.supabaseAnonKey || cfg.supabaseAnonKey || "",
            controlServerUrl: prev.controlServerUrl || cfg.controlServerUrl || prev.controlServerUrl,
            apiBaseUrl:
              !prev.apiBaseUrl || (!runsOverHttp && prev.apiBaseUrl === "/")
                ? resolvedBase
                : prev.apiBaseUrl,
          }));
          return;
        } catch {
          // try next candidate
        }
      }
    })();
  }, [settings.apiBaseUrl, settings.supabaseUrl, settings.supabaseAnonKey]);

  useEffect(() => {
    saveChatLayout(chatLayout);
  }, [chatLayout]);

  useEffect(() => {
    saveRequestLayout(requestLayout);
  }, [requestLayout]);

  useEffect(() => {
    savePollPresets(pollPresets);
  }, [pollPresets]);

  useEffect(() => {
    void refreshRequests();
    const poll = setInterval(() => void refreshRequests(), 5000);
    return () => clearInterval(poll);
  }, [settings.apiBaseUrl]);

  useEffect(() => {
    void refreshLivePoll();
    const timer = setInterval(() => void refreshLivePoll(), 4000);
    return () => clearInterval(timer);
  }, [settings.apiBaseUrl]);

  useEffect(() => {
    if (!supabase) return;

    const chatChannel = supabase
      .channel("overlay-chat")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload) => {
          const next = payload.new as ChatMessage;
          setChatMessages((prev) => {
            const merged = [...prev, next];
            return merged.length > MAX_CHAT ? merged.slice(-MAX_CHAT) : merged;
          });
        },
      )
      .subscribe();

    const requestChannel = supabase
      .channel("overlay-requests")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "requests" },
        () => void refreshRequests(),
      )
      .subscribe();

    const nowPlayingChannel = supabase
      .channel("overlay-now-playing")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "now_playing", filter: "id=eq.1" },
        (payload) => {
          const row = payload.new as NowPlaying;
          setNowPlaying({
            title: row.title ?? null,
            artist: row.artist ?? null,
            artwork_url: row.artwork_url ?? null,
            updated_at: row.updated_at,
          });
        },
      )
      .subscribe();

    void supabase
      .from("chat_messages")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(40)
      .then(({ data }) => {
        setChatMessages(((data ?? []) as ChatMessage[]).reverse());
      });

    void supabase
      .from("now_playing")
      .select("title,artist,artwork_url,updated_at")
      .eq("id", 1)
      .single()
      .then(({ data }) => {
        if (data) setNowPlaying(data as NowPlaying);
      });

    return () => {
      supabase.removeChannel(chatChannel);
      supabase.removeChannel(requestChannel);
      supabase.removeChannel(nowPlayingChannel);
    };
  }, [supabase]);

  useEffect(() => {
    if (!supabase) return;

    const presenceChannel = supabase.channel("online-users", {
      config: { presence: { key: nickname } },
    });

    presenceChannel
      .on("presence", { event: "sync" }, () => {
        const state = presenceChannel.presenceState<{ nickname: string }>();
        const users = Object.keys(state).sort((a, b) => a.localeCompare(b));
        setOnlineUsers(users);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await presenceChannel.track({ nickname });
        }
      });

    return () => {
      supabase.removeChannel(presenceChannel);
    };
  }, [supabase, nickname]);

  useEffect(() => {
    if (!nowPlaying.title && !nowPlaying.artist) return;
    const toResolve = openRequests.filter((r) =>
      matchesNowPlaying(nowPlaying, {
        title: r.title,
        artist: r.artist,
        url: r.url,
      }),
    );
    if (toResolve.length === 0) return;
    setResolvedIds((prev) => {
      const copy = { ...prev };
      const ts = new Date().toISOString();
      for (const req of toResolve) copy[req.id] = ts;
      return copy;
    });
  }, [nowPlaying, openRequests]);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatMessages]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() ?? "";
      const isTypingTarget =
        tag === "input" || tag === "textarea" || tag === "select" || Boolean(target?.isContentEditable);
      const isArrowNav = e.key === "ArrowDown" || e.key === "ArrowUp";

      if (isArrowNav && !isTypingTarget && openRequests.length > 0) {
        e.preventDefault();
        const currentId = selectedRequest?.id ?? selectedId;
        const currentIndex = currentId ? openRequests.findIndex((r) => r.id === currentId) : -1;
        const baseIndex = currentIndex >= 0 ? currentIndex : 0;
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const nextIndex = Math.max(0, Math.min(openRequests.length - 1, baseIndex + delta));
        const nextId = openRequests[nextIndex]?.id;
        if (nextId) {
          setSelectedId(nextId);
          window.requestAnimationFrame(() => {
            const row = document.querySelector(`[data-request-id="${nextId}"]`);
            row?.scrollIntoView({ block: "nearest" });
          });
        }
        return;
      }

      if (!(e.ctrlKey || e.metaKey) && e.key !== "Escape") return;
      if (e.key === "Escape") {
        setSettings((prev) => ({ ...prev, clickThrough: false }));
        return;
      }
      switch (e.key.toLowerCase()) {
        case "l":
          e.preventDefault();
          setSettings((prev) => ({ ...prev, lockLayout: !prev.lockLayout }));
          break;
        case "1":
          e.preventDefault();
          setSettings((prev) => ({ ...prev, showChat: !prev.showChat }));
          break;
        case "2":
          e.preventDefault();
          setSettings((prev) => ({ ...prev, showRequests: !prev.showRequests }));
          break;
        case "3":
          e.preventDefault();
          setSettings((prev) => ({ ...prev, showTopBar: !prev.showTopBar }));
          break;
        case "i":
          e.preventDefault();
          setSettings((prev) => ({ ...prev, clickThrough: !prev.clickThrough }));
          break;
        case "r":
          e.preventDefault();
          if (e.shiftKey && selectedRequest) {
            void changeStatus(selectedRequest.id, "rejected");
            break;
          }
          void refreshRequests();
          void refreshLivePoll();
          break;
        case "a":
          if (e.shiftKey && selectedRequest) {
            e.preventDefault();
            void changeStatus(selectedRequest.id, "approved");
          }
          break;
        case "s":
          if (e.shiftKey && selectedRequest) {
            e.preventDefault();
            void sendShoutout(selectedRequest.nickname);
          }
          break;
        case "p":
          if (e.shiftKey) {
            e.preventDefault();
            if (activePoll) void closeLivePoll();
            else void createLivePoll();
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activePoll, openRequests, selectedId, selectedRequest, pollQuestion, pollOptionsInput, shoutoutMessage, settings.adminToken, settings.apiBaseUrl]);

  useEffect(() => {
    if (activeTool !== "search") return;
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(() => void runSearch(q, searchSource), 220);
    return () => clearTimeout(timer);
  }, [activeTool, searchQuery, searchSource, settings.controlServerUrl]);

  return (
    <div className="h-full w-full p-3">
      {settings.showTopBar && (
        <>
          <div
            data-overlay-interactive="true"
            className="mb-3 flex items-center gap-2 rounded-lg border border-gray-700/70 bg-gray-900/85 px-3 py-2 text-xs"
          >
            <span className="font-semibold text-violet-300">DJ Overlay</span>
            <span className={connectionText === "Connected" ? "text-green-300" : "text-yellow-300"}>
              {connectionText}
            </span>
            <span className="text-gray-400">
              Ctrl+L lock • Ctrl+1/2/3 panels • Ctrl+I click-through • Ctrl+Shift+A accept • Ctrl+Shift+R reject • Ctrl+Shift+S shoutout • Ctrl+Shift+P poll
            </span>
            <button
              onClick={() => setSettings((prev) => ({ ...prev, lockLayout: !prev.lockLayout }))}
              className="ml-auto rounded bg-gray-700/80 px-2 py-1 text-[11px] hover:bg-gray-600"
            >
              {settings.lockLayout ? "Unlock" : "Lock"}
            </button>
            <button
              onClick={() => setSettings((prev) => ({ ...prev, clickThrough: !prev.clickThrough }))}
              className="rounded bg-gray-700/80 px-2 py-1 text-[11px] hover:bg-gray-600"
            >
              {settings.clickThrough ? "ClickThrough ON" : "ClickThrough OFF"}
            </button>
            <button
              onClick={() => {
                setChatLayout({ x: 24, y: 24, width: 420, height: 420 });
                setRequestLayout({ x: 480, y: 24, width: 460, height: 560 });
              }}
              className="rounded bg-gray-700/80 px-2 py-1 text-[11px] hover:bg-gray-600"
            >
              Reset Panels
            </button>
            <button
              onClick={() => setShowShortcutsHelp((prev) => !prev)}
              className={`rounded px-2 py-1 text-[11px] ${
                showShortcutsHelp ? "bg-violet-600/40 text-violet-100" : "bg-gray-700/80 hover:bg-gray-600"
              }`}
            >
              Shortcuts
            </button>
          </div>

          {showShortcutsHelp && (
            <div
              data-overlay-interactive="true"
              className="mb-3 rounded-lg border border-violet-500/30 bg-gray-900/90 p-3 text-xs text-gray-200"
            >
              <div className="mb-1 font-semibold text-violet-300">Keyboard shortcuts</div>
              <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
                <div><span className="text-violet-200">Ctrl+L</span> - Lock/unlock panel layout</div>
                <div><span className="text-violet-200">Ctrl+1</span> - Chat panel tonen/verbergen</div>
                <div><span className="text-violet-200">Ctrl+2</span> - Verzoekjes panel tonen/verbergen</div>
                <div><span className="text-violet-200">Ctrl+3</span> - Topbar tonen/verbergen</div>
                <div><span className="text-violet-200">Ctrl+I</span> - Click-through aan/uit</div>
                <div><span className="text-violet-200">Esc</span> - Click-through uit</div>
                <div><span className="text-violet-200">Ctrl+R</span> - Refresh verzoekjes + poll</div>
                <div><span className="text-violet-200">Ctrl+Shift+A</span> - Geselecteerd verzoek accepteren</div>
                <div><span className="text-violet-200">Ctrl+Shift+R</span> - Geselecteerd verzoek afwijzen</div>
                <div><span className="text-violet-200">Ctrl+Shift+S</span> - Shoutout naar geselecteerd verzoek</div>
                <div><span className="text-violet-200">Ctrl+Shift+P</span> - Poll starten/sluiten</div>
              </div>
            </div>
          )}

          <div
            data-overlay-interactive="true"
            className="mb-3 grid grid-cols-1 gap-2 rounded-lg border border-gray-700/70 bg-gray-900/85 p-3 text-xs md:grid-cols-5"
          >
            <input
              className="rounded border border-gray-700 bg-gray-800 px-2 py-1"
              value={settings.apiBaseUrl}
              onChange={(e) => setSettings((p) => ({ ...p, apiBaseUrl: e.target.value }))}
              placeholder="API base URL"
            />
            <input
              className="rounded border border-gray-700 bg-gray-800 px-2 py-1"
              value={settings.controlServerUrl}
              onChange={(e) => setSettings((p) => ({ ...p, controlServerUrl: e.target.value }))}
              placeholder="Control server URL"
            />
            <input
              className="rounded border border-gray-700 bg-gray-800 px-2 py-1"
              value={settings.adminToken}
              onChange={(e) => setSettings((p) => ({ ...p, adminToken: e.target.value }))}
              placeholder="Admin token"
            />
            <input
              className="rounded border border-gray-700 bg-gray-800 px-2 py-1"
              value={settings.supabaseUrl}
              onChange={(e) => setSettings((p) => ({ ...p, supabaseUrl: e.target.value }))}
              placeholder="Supabase URL"
            />
            <input
              className="rounded border border-gray-700 bg-gray-800 px-2 py-1"
              value={settings.supabaseAnonKey}
              onChange={(e) => setSettings((p) => ({ ...p, supabaseAnonKey: e.target.value }))}
              placeholder="Supabase anon key"
            />
          </div>
        </>
      )}

      {lastError && (
        <div className="mb-3 rounded border border-red-500/50 bg-red-900/35 px-3 py-2 text-xs text-red-200">
          {lastError}
        </div>
      )}

      {settings.showChat && (
        <Rnd
          data-overlay-interactive="true"
          bounds="window"
          size={{ width: chatLayout.width, height: chatLayout.height }}
          position={{ x: chatLayout.x, y: chatLayout.y }}
          onDragStop={(_e, d) => setChatLayout((prev) => ({ ...prev, x: d.x, y: d.y }))}
          onResizeStop={(_e, _dir, ref, _delta, position) =>
            setChatLayout({
              x: position.x,
              y: position.y,
              width: ref.offsetWidth,
              height: ref.offsetHeight,
            })
          }
          disableDragging={settings.lockLayout || settings.clickThrough}
          enableResizing={!settings.lockLayout && !settings.clickThrough}
        >
          <div data-overlay-interactive="true" className="overlay-panel flex h-full flex-col overflow-hidden">
            <div className="relative border-b border-gray-700/70 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-violet-300">Chat</span>
                <button
                  type="button"
                  onClick={() => setOnlineExpanded((prev) => !prev)}
                  className="ml-auto flex items-center gap-1 rounded border border-gray-700 bg-gray-800/70 px-2 py-1 text-[11px] text-gray-300 hover:text-white"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  <span>{onlineUsers.length} online</span>
                </button>
              </div>
              {onlineExpanded && (
                <div className="absolute right-3 top-full z-30 mt-2 w-52 rounded-lg border border-gray-700 bg-gray-900 p-2 shadow-xl shadow-black/45">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">Online gebruikers</div>
                  {onlineUsers.length === 0 ? (
                    <div className="text-[11px] text-gray-400">Niemand online.</div>
                  ) : (
                    <ul className="max-h-40 space-y-1 overflow-y-auto">
                      {onlineUsers.map((user) => (
                        <li key={user} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs text-gray-200">
                          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                          <span className="truncate">
                            {user}
                            {user === nickname ? <span className="ml-1 text-[10px] text-gray-500">(jij)</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <div ref={chatScrollRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2 text-sm">
              {chatMessages.map((m) => (
                <div key={m.id}>
                  <span className="font-semibold text-violet-300">{m.nickname}</span>
                  <span className="mx-1 text-gray-500">{timeStr(m.created_at)}</span>
                  <span className="text-gray-200">{m.content}</span>
                </div>
              ))}
            </div>
          </div>
        </Rnd>
      )}

      {settings.showRequests && (
        <Rnd
          data-overlay-interactive="true"
          bounds="window"
          size={{ width: requestLayout.width, height: requestLayout.height }}
          position={{ x: requestLayout.x, y: requestLayout.y }}
          onDragStop={(_e, d) => setRequestLayout((prev) => ({ ...prev, x: d.x, y: d.y }))}
          onResizeStop={(_e, _dir, ref, _delta, position) =>
            setRequestLayout({
              x: position.x,
              y: position.y,
              width: ref.offsetWidth,
              height: ref.offsetHeight,
            })
          }
          disableDragging={settings.lockLayout || settings.clickThrough}
          enableResizing={!settings.lockLayout && !settings.clickThrough}
        >
          <div data-overlay-interactive="true" className="overlay-panel flex h-full flex-col overflow-hidden">
            <div className="border-b border-gray-700/70 px-3 py-2">
              <div className="flex items-center gap-2">
                <div className="text-sm font-semibold text-violet-300">Verzoekjes ({openRequests.length} open)</div>
                <button
                  type="button"
                  onClick={() => setActiveTool((prev) => (prev === "search" ? "none" : "search"))}
                  className={`ml-auto rounded px-2 py-1 text-[11px] ${
                    activeTool === "search" ? "bg-violet-600/40 text-violet-100" : "bg-gray-700/80 hover:bg-gray-600"
                  }`}
                >
                  Zoeken
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTool((prev) => (prev === "poll" ? "none" : "poll"))}
                  className={`rounded px-2 py-1 text-[11px] ${
                    activeTool === "poll" ? "bg-fuchsia-600/40 text-fuchsia-100" : "bg-gray-700/80 hover:bg-gray-600"
                  }`}
                >
                  Poll
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTool((prev) => (prev === "shoutout" ? "none" : "shoutout"))}
                  className={`rounded px-2 py-1 text-[11px] ${
                    activeTool === "shoutout" ? "bg-amber-600/40 text-amber-100" : "bg-gray-700/80 hover:bg-gray-600"
                  }`}
                >
                  Shoutout
                </button>
              </div>
              <div className="mt-1 text-xs text-gray-300">
                Now playing: {nowPlaying.artist ? `${nowPlaying.artist} — ` : ""}{nowPlaying.title ?? "geen track"}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
            {activeTool === "search" && (
              <div className="border-b border-gray-700/60 bg-gray-900/75 p-2">
                <div className="mb-2 flex gap-1 rounded bg-gray-800 p-1 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setSearchSource("youtube")}
                    className={`flex-1 rounded px-2 py-1 font-semibold ${
                      searchSource === "youtube" ? "bg-red-500/20 text-red-300" : "text-gray-300"
                    }`}
                  >
                    YouTube
                  </button>
                  <button
                    type="button"
                    onClick={() => setSearchSource("soundcloud")}
                    className={`flex-1 rounded px-2 py-1 font-semibold ${
                      searchSource === "soundcloud" ? "bg-orange-500/20 text-orange-300" : "text-gray-300"
                    }`}
                  >
                    SoundCloud
                  </button>
                </div>
                <div className="mb-2 flex items-center gap-2">
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Zoek track..."
                    className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100"
                  />
                  {searching && <span className="text-[11px] text-gray-400">Zoeken...</span>}
                </div>
                <label className="mb-2 flex items-center gap-2 text-[11px] text-gray-300">
                  <input
                    type="checkbox"
                    checked={autoApproveOnAdd}
                    onChange={(e) => setAutoApproveOnAdd(e.target.checked)}
                  />
                  Direct accepteren (start download meteen)
                </label>
                {searchFeedback && <div className="mb-2 text-[11px] text-violet-200">{searchFeedback}</div>}
                <div className="max-h-36 overflow-y-auto rounded border border-gray-700/60 bg-gray-950/50">
                  {searchResults.length === 0 ? (
                    <div className="p-2 text-[11px] text-gray-400">Geen resultaten.</div>
                  ) : (
                    searchResults.map((item) => (
                      <div key={item.id || item.url} className="flex items-center gap-2 border-b border-gray-800/70 p-2 last:border-b-0">
                        {item.thumbnail ? (
                          <img src={item.thumbnail} alt="" className="h-8 w-12 rounded object-cover" />
                        ) : (
                          <div className="h-8 w-12 rounded bg-gray-800" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs text-gray-100">{item.title}</div>
                          <div className="truncate text-[11px] text-gray-400">
                            {item.channel ?? item.url}
                            {item.duration ? ` • ${formatDuration(item.duration)}` : ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void addSearchResult(item)}
                          disabled={addingRequest}
                          className="rounded bg-violet-600/30 px-2 py-1 text-[11px] text-violet-100 hover:bg-violet-600/50 disabled:opacity-40"
                        >
                          Toevoegen
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
            {(activeTool === "poll" || activeTool === "shoutout") && (
              <div className="border-b border-gray-700/60 bg-gray-900/75 p-2 text-xs">
                {activeTool === "poll" && (
                  <div className="mb-2 rounded border border-gray-700/70 bg-gray-950/50 p-2">
                    <div className="mb-1 font-semibold text-fuchsia-300">Live poll</div>
                    {activePoll ? (
                      <div className="mb-2">
                        <div className="text-gray-100">{activePoll.question}</div>
                        <div className="mt-1 text-[11px] text-gray-400">
                          {activePoll.totalVotes} stemmen • {activePoll.options.map((opt, i) => `${opt}: ${activePoll.counts[i] ?? 0}`).join(" | ")}
                        </div>
                      </div>
                    ) : (
                      <div className="mb-2 text-[11px] text-gray-400">Geen actieve poll.</div>
                    )}
                    <input
                      value={pollQuestion}
                      onChange={(e) => setPollQuestion(e.target.value)}
                      placeholder="Vraag (bijv: Wat wil je nu horen?)"
                      className="mb-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100"
                    />
                    <input
                      value={pollOptionsInput}
                      onChange={(e) => setPollOptionsInput(e.target.value)}
                      placeholder="Opties met komma's"
                      className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100"
                    />
                    <div className="mt-2">
                      <div className="mb-1 text-[11px] text-gray-400">Genres aanklikken</div>
                      <div className="flex flex-wrap gap-1.5">
                        {GENRE_OPTION_CHIPS.map((genreOption) => {
                          const selected = parsePollOptions(pollOptionsInput).some(
                            (opt) => opt.toLowerCase() === genreOption.toLowerCase(),
                          );
                          return (
                            <button
                              key={genreOption}
                              type="button"
                              onClick={() => toggleGenreOption(genreOption)}
                              className={`rounded-full border px-2 py-1 text-[11px] ${
                                selected
                                  ? "border-fuchsia-400/60 bg-fuchsia-500/25 text-fuchsia-100"
                                  : "border-gray-600 bg-gray-800/60 text-gray-200 hover:border-gray-500"
                              }`}
                            >
                              {genreOption}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="mt-2">
                      <div className="mb-1 text-[11px] text-gray-400">Standaard polls</div>
                      <div className="flex flex-wrap gap-1.5">
                        {DEFAULT_POLL_TEMPLATES.map((tpl) => (
                          <button
                            key={tpl.name}
                            type="button"
                            onClick={() => applyPollTemplate(tpl.question, tpl.options)}
                            className="rounded border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 py-1 text-[11px] text-fuchsia-100 hover:bg-fuchsia-500/20"
                          >
                            {tpl.name}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="mt-2 rounded border border-gray-700/70 bg-gray-900/60 p-2">
                      <div className="mb-1 text-[11px] text-gray-300">Preset opslaan / terughalen</div>
                      <div className="mb-1 flex gap-1.5">
                        <input
                          value={pollPresetName}
                          onChange={(e) => setPollPresetName(e.target.value)}
                          placeholder="Preset naam"
                          className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[11px] text-gray-100"
                        />
                        <button
                          type="button"
                          onClick={saveCurrentPollPreset}
                          className="rounded bg-fuchsia-600/30 px-2 py-1 text-[11px] font-semibold text-fuchsia-100 hover:bg-fuchsia-600/50"
                        >
                          Opslaan
                        </button>
                      </div>
                      <div className="flex gap-1.5">
                        <select
                          value={selectedPresetId}
                          onChange={(e) => setSelectedPresetId(e.target.value)}
                          className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[11px] text-gray-100"
                        >
                          <option value="">Kies opgeslagen preset...</option>
                          {pollPresets.map((preset) => (
                            <option key={preset.id} value={preset.id}>
                              {preset.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={loadSelectedPollPreset}
                          disabled={!selectedPresetId}
                          className="rounded bg-gray-700/80 px-2 py-1 text-[11px] text-gray-200 hover:bg-gray-600 disabled:opacity-40"
                        >
                          Laden
                        </button>
                        <button
                          type="button"
                          onClick={removeSelectedPollPreset}
                          disabled={!selectedPresetId}
                          className="rounded bg-red-600/25 px-2 py-1 text-[11px] text-red-200 hover:bg-red-600/40 disabled:opacity-40"
                        >
                          Verwijder
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void createLivePoll()}
                        className="rounded bg-fuchsia-600/30 px-2 py-1 text-[11px] font-semibold text-fuchsia-100 hover:bg-fuchsia-600/50"
                      >
                        Poll starten
                      </button>
                      <button
                        type="button"
                        onClick={() => void closeLivePoll()}
                        disabled={!activePoll}
                        className="rounded bg-gray-700/80 px-2 py-1 text-[11px] text-gray-200 hover:bg-gray-600 disabled:opacity-40"
                      >
                        Poll sluiten
                      </button>
                    </div>
                    {pollFeedback ? <div className="mt-1 text-[11px] text-fuchsia-200">{pollFeedback}</div> : null}
                  </div>
                )}

                {activeTool === "shoutout" && (
                  <div className="rounded border border-gray-700/70 bg-gray-950/50 p-2">
                    <div className="mb-1 font-semibold text-amber-300">Shoutout</div>
                    <div className="mb-1 text-[11px] text-gray-400">
                      Doel: {selectedRequest?.nickname ?? "kies eerst een verzoekje"}
                    </div>
                    <input
                      value={shoutoutMessage}
                      onChange={(e) => setShoutoutMessage(e.target.value)}
                      placeholder="Bericht (bijv: dikke aanvraag 🔥)"
                      className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100"
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void sendShoutout()}
                        className="rounded bg-amber-600/30 px-2 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-600/50"
                      >
                        Stuur shoutout
                      </button>
                    </div>
                    {shoutoutFeedback ? <div className="mt-1 text-[11px] text-amber-200">{shoutoutFeedback}</div> : null}
                  </div>
                )}
              </div>
            )}
            <div className="grid min-h-[320px] grid-cols-5 gap-2 p-2 text-sm">
              <div className="col-span-2 min-h-0 overflow-y-auto rounded border border-gray-700/60 bg-gray-900/60">
                {openRequests.length === 0 && (
                  <div className="p-2 text-xs text-gray-400">Geen open verzoekjes.</div>
                )}
                {openRequests.map((r) => (
                  <button
                    key={r.id}
                    data-request-id={r.id}
                    onClick={() => setSelectedId(r.id)}
                    className={`w-full border-b border-gray-700/60 p-2 text-left text-xs hover:bg-gray-800/70 ${
                      selectedRequest?.id === r.id ? "bg-violet-500/20" : ""
                    }`}
                  >
                    <div className="font-semibold text-violet-200">{r.nickname}</div>
                    <div className="truncate text-gray-200">{r.title ?? r.url}</div>
                    {typeof r.duration === "number" && r.duration > 0 && (
                      <div className="truncate text-[11px] text-gray-500">Lengte: {formatDuration(r.duration)}</div>
                    )}
                    {r.genre && <div className="truncate text-[11px] text-fuchsia-300">Genre: {r.genre}</div>}
                    <div className="mt-1">
                      <span
                        className={`rounded px-1.5 py-0.5 ${
                          r.status === "approved"
                            ? "bg-green-500/20 text-green-300"
                            : r.status === "downloaded"
                              ? "bg-violet-500/20 text-violet-300"
                              : "bg-yellow-500/20 text-yellow-300"
                        }`}
                      >
                        {r.status === "approved"
                          ? "Auto accepted"
                          : r.status === "downloaded"
                            ? "Downloaded"
                            : "Pending"}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              <div className="col-span-3 min-h-0 overflow-y-auto rounded border border-gray-700/60 bg-gray-900/60 p-3">
                {selectedRequest ? (
                  <div className="flex h-full flex-col">
                    <div className="mb-2 flex items-start gap-3">
                      {selectedRequest.thumbnail ? (
                        <img
                          src={selectedRequest.thumbnail}
                          className="h-16 w-16 rounded object-cover"
                          alt=""
                        />
                      ) : (
                        <div className="h-16 w-16 rounded bg-gray-700" />
                      )}
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-white">
                          {selectedRequest.title ?? "Onbekende titel"}
                        </div>
                        <div className="text-xs text-gray-300">{selectedRequest.artist ?? selectedRequest.nickname}</div>
                        {typeof selectedRequest.duration === "number" && selectedRequest.duration > 0 && (
                          <div className="text-xs text-gray-500">Lengte: {formatDuration(selectedRequest.duration)}</div>
                        )}
                        {selectedRequest.genre && (
                          <div className="text-xs text-fuchsia-300">
                            Genre: {selectedRequest.genre}
                            {selectedRequest.genre_confidence === "artist_based" ? " (op artiest)" : ""}
                          </div>
                        )}
                        <div className="mt-1 text-[11px] text-gray-400">{selectedRequest.url}</div>
                      </div>
                    </div>
                    <div className="mt-auto flex flex-wrap gap-2">
                      <button
                        onClick={() => void changeStatus(selectedRequest.id, "approved")}
                        className="rounded bg-green-600/30 px-3 py-1.5 text-xs font-semibold text-green-200 hover:bg-green-600/50"
                      >
                        Accepteren
                      </button>
                      <button
                        onClick={() => void changeStatus(selectedRequest.id, "rejected")}
                        className="rounded bg-red-600/30 px-3 py-1.5 text-xs font-semibold text-red-200 hover:bg-red-600/50"
                      >
                        Afwijzen
                      </button>
                      <button
                        onClick={() =>
                          setResolvedIds((prev) => ({
                            ...prev,
                            [selectedRequest.id]: new Date().toISOString(),
                          }))
                        }
                        className="rounded bg-blue-600/30 px-3 py-1.5 text-xs font-semibold text-blue-200 hover:bg-blue-600/50"
                      >
                        Verberg (matched)
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-gray-400">Selecteer een open verzoekje.</div>
                )}
              </div>
            </div>
            </div>
          </div>
        </Rnd>
      )}
    </div>
  );
}

export default App;
