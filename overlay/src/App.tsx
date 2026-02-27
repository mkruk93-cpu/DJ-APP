import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Rnd } from "react-rnd";
import type {
  ChatMessage,
  NowPlaying,
  OverlaySettings,
  PanelLayout,
  RequestItem,
} from "./types";
import {
  loadChatLayout,
  loadRequestLayout,
  loadSettings,
  saveChatLayout,
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

function timeStr(iso: string): string {
  return new Date(iso).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
}

function App() {
  const [settings, setSettings] = useState<OverlaySettings>(() => {
    const base = loadSettings();
    const runsOverHttp = typeof window !== "undefined" && window.location.protocol.startsWith("http");
    const defaultApiBase = runsOverHttp ? "/" : "http://localhost:3000";
    return {
      ...base,
      apiBaseUrl: base.apiBaseUrl || defaultApiBase,
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
      (r) =>
        (r.status === "pending" || r.status === "approved" || r.status === "downloaded") &&
        !resolvedIds[r.id],
    );
  }, [requests, resolvedIds]);

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
          .select("id,nickname,url,title,artist,thumbnail,source,genre,genre_confidence,status,created_at")
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
    void refreshRequests();
    const poll = setInterval(() => void refreshRequests(), 5000);
    return () => clearInterval(poll);
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
          void refreshRequests();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
              Ctrl+L lock • Ctrl+1 chat • Ctrl+2 requests • Ctrl+3 topbar • Ctrl+I click-through
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
          </div>

          <div
            data-overlay-interactive="true"
            className="mb-3 grid grid-cols-1 gap-2 rounded-lg border border-gray-700/70 bg-gray-900/85 p-3 text-xs md:grid-cols-4"
          >
            <input
              className="rounded border border-gray-700 bg-gray-800 px-2 py-1"
              value={settings.apiBaseUrl}
              onChange={(e) => setSettings((p) => ({ ...p, apiBaseUrl: e.target.value }))}
              placeholder="API base URL"
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
            <div className="border-b border-gray-700/70 px-3 py-2 text-sm font-semibold text-violet-300">
              Chat
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
              <div className="text-sm font-semibold text-violet-300">Verzoekjes ({openRequests.length} open)</div>
              <div className="mt-1 text-xs text-gray-300">
                Now playing: {nowPlaying.artist ? `${nowPlaying.artist} — ` : ""}{nowPlaying.title ?? "geen track"}
              </div>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-5 gap-2 p-2 text-sm">
              <div className="col-span-2 min-h-0 overflow-y-auto rounded border border-gray-700/60 bg-gray-900/60">
                {openRequests.length === 0 && (
                  <div className="p-2 text-xs text-gray-400">Geen open verzoekjes.</div>
                )}
                {openRequests.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    className={`w-full border-b border-gray-700/60 p-2 text-left text-xs hover:bg-gray-800/70 ${
                      selectedRequest?.id === r.id ? "bg-violet-500/20" : ""
                    }`}
                  >
                    <div className="font-semibold text-violet-200">{r.nickname}</div>
                    <div className="truncate text-gray-200">{r.title ?? r.url}</div>
                    {r.genre && <div className="truncate text-[11px] text-fuchsia-300">Genre: {r.genre}</div>}
                    <div className="mt-1">
                      <span className={`rounded px-1.5 py-0.5 ${
                        r.status === "approved" ? "bg-green-500/20 text-green-300" : "bg-yellow-500/20 text-yellow-300"
                      }`}>
                        {r.status === "approved" ? "Auto accepted" : "Pending"}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              <div className="col-span-3 min-h-0 rounded border border-gray-700/60 bg-gray-900/60 p-3">
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
        </Rnd>
      )}
    </div>
  );
}

export default App;
