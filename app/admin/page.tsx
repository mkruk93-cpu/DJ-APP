"use client";

import { useEffect, useState, useCallback } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import { connectSocket, disconnectSocket, getSocket } from "@/lib/socket";
import { useRadioStore } from "@/lib/radioStore";
import { getRadioToken, setRadioToken, clearRadioToken } from "@/lib/auth";
import { skipTrack as apiSkipTrack, setKeepFiles as apiSetKeepFiles } from "@/lib/radioApi";
import AdminRequestCard from "@/components/AdminRequestCard";
import ModeSelector from "@/components/admin/ModeSelector";
import ModeSettings from "@/components/admin/ModeSettings";
import QueueManager from "@/components/admin/QueueManager";
import QueueAdd from "@/components/QueueAdd";
import ListenerCount from "@/components/admin/ListenerCount";
import StreamStatus from "@/components/admin/StreamStatus";
import PlayedHistory from "@/components/admin/PlayedHistory";
import DurationVotePanel from "@/components/DurationVote";
import type { Track, QueueItem, Mode, ModeSettings as ModeSettingsType, VoteState, DurationVote } from "@/lib/types";

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

const ADMIN_PASSWORD = process.env.NEXT_PUBLIC_ADMIN_PASSWORD;

const statusOrder: Record<string, number> = { pending: 0, approved: 1, downloaded: 2, rejected: 3 };

type AdminTab = "requests" | "radio";

export default function AdminPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [requests, setRequests] = useState<Request[]>([]);
  const [autoApprove, setAutoApprove] = useState(false);
  const [icecastUrl, setIcecastUrl] = useState("");
  const [icecastSaved, setIcecastSaved] = useState(false);
  const [radioServerUrl, setRadioServerUrl] = useState("");
  const [radioUrlSaved, setRadioUrlSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTab>("requests");

  // Radio admin auth
  const [radioToken, setRadioTokenState] = useState("");
  const [radioAuthError, setRadioAuthError] = useState("");
  const [radioAuthed, setRadioAuthed] = useState(false);
  const [keepFiles, setKeepFiles] = useState(false);

  const radioConnected = useRadioStore((s) => s.connected);
  const radioTrack = useRadioStore((s) => s.currentTrack);
  const store = useRadioStore;

  useEffect(() => {
    if (sessionStorage.getItem("admin_auth") === "true") {
      setAuthenticated(true);
    }
    if (getRadioToken()) {
      setRadioAuthed(true);
    }
  }, []);

  // Auto-authenticate radio when admin password matches the admin token
  useEffect(() => {
    if (!authenticated || radioAuthed) return;
    const token = ADMIN_PASSWORD ?? "";
    setRadioToken(token);
    setRadioAuthed(true);
  }, [authenticated, radioAuthed]);

  // Initialize Socket.io for radio admin
  const effectiveServerUrl = radioServerUrl || process.env.NEXT_PUBLIC_CONTROL_SERVER_URL || "";
  useEffect(() => {
    if (!authenticated || !effectiveServerUrl) return;
    const serverUrl = effectiveServerUrl;

    let socket: ReturnType<typeof connectSocket>;
    try {
      socket = connectSocket(serverUrl);
    } catch { return; }

    function fetchState() {
      fetch(`${serverUrl}/state`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((state) => {
          store.getState().initFromServer({
            currentTrack: state.currentTrack ?? null,
            queue: state.queue ?? [],
            mode: state.mode ?? "radio",
            modeSettings: state.modeSettings ?? store.getState().modeSettings,
            listenerCount: state.listenerCount ?? 0,
            streamOnline: state.streamOnline ?? false,
            durationVote: state.durationVote ?? null,
          });
        })
        .catch((err) => {
          console.warn("[radio] Failed to fetch state:", err.message);
          setTimeout(fetchState, 3000);
        });
    }

    socket.on("connect", () => {
      store.getState().setConnected(true);
      fetchState();
    });

    socket.on("disconnect", () => store.getState().resetAll());
    socket.on("track:change", (track: Track | null) => {
      store.getState().setCurrentTrack(track);
      store.getState().setStreamOnline(track !== null);
      store.getState().setVoteState(null);
    });
    socket.on("queue:update", (data: { items: QueueItem[] }) => store.getState().setQueue(data.items));
    socket.on("mode:change", (data: { mode: Mode; settings: ModeSettingsType }) => store.getState().setMode(data.mode, data.settings));
    socket.on("vote:update", (data: VoteState | null) => store.getState().setVoteState(data));
    socket.on("stream:status", (data: { online: boolean; listeners: number }) => {
      store.getState().setStreamOnline(data.online);
      store.getState().setListenerCount(data.listeners);
    });
    socket.on("error:toast", (data: { message: string }) => {
      console.warn("[radio admin]", data.message);
    });
    socket.on("settings:keepFilesChanged", (data: { keep: boolean }) => {
      setKeepFiles(data.keep);
    });
    socket.on("durationVote:update", (data: DurationVote & { voters: string[] }) => {
      const voted = data.voters?.includes(socket.id ?? "") ?? false;
      store.getState().setDurationVote({ ...data, voted });
    });
    socket.on("durationVote:end", () => {
      store.getState().setDurationVote(null);
    });

    return () => disconnectSocket();
  }, [authenticated, effectiveServerUrl, store]);

  const loadRequests = useCallback(async () => {
    const { data } = await getSupabase()
      .from("requests")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) {
      const sorted = [...data].sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));
      setRequests(sorted);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    const { data, error } = await getSupabase()
      .from("settings")
      .select("*")
      .eq("id", 1)
      .single();
    if (error) {
      console.warn("[admin] Failed to load settings:", error.message);
      return;
    }
    if (data) {
      setAutoApprove(data.auto_approve ?? false);
      setIcecastUrl(data.icecast_url ?? "");
      const rUrl = data.radio_server_url ?? "";
      setRadioServerUrl(rUrl);
      store.getState().setServerUrl(rUrl || null);
    }
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    loadRequests();
    loadSettings();

    const sb = getSupabase();
    const channel = sb
      .channel("admin-requests")
      .on<Request>(
        "postgres_changes",
        { event: "*", schema: "public", table: "requests" },
        () => { loadRequests(); }
      )
      .subscribe();

    return () => { sb.removeChannel(channel); };
  }, [authenticated, loadRequests, loadSettings]);

  function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (password === ADMIN_PASSWORD) {
      setAuthenticated(true);
      sessionStorage.setItem("admin_auth", "true");
      setRadioToken(password);
      setRadioAuthed(true);
    } else {
      setError("Onjuist wachtwoord.");
    }
  }

  async function toggleAutoApprove() {
    const next = !autoApprove;
    setAutoApprove(next);
    await getSupabase()
      .from("settings")
      .update({ auto_approve: next })
      .eq("id", 1);
  }

  async function saveIcecastUrl() {
    await getSupabase()
      .from("settings")
      .update({ icecast_url: icecastUrl.trim() || null })
      .eq("id", 1);
    setIcecastSaved(true);
    setTimeout(() => setIcecastSaved(false), 2000);
  }

  async function saveRadioServerUrl() {
    const url = radioServerUrl.trim().replace(/\/+$/, "") || null;
    await getSupabase()
      .from("settings")
      .update({ radio_server_url: url })
      .eq("id", 1);
    setRadioServerUrl(url ?? "");
    store.getState().setServerUrl(url);
    setRadioUrlSaved(true);
    setTimeout(() => setRadioUrlSaved(false), 2000);
  }

  function handleRadioAuth(e: React.FormEvent) {
    e.preventDefault();
    const socket = getSocket();
    socket.emit("auth:verify", { token: radioToken }, (valid: boolean) => {
      if (valid) {
        setRadioToken(radioToken);
        setRadioAuthed(true);
        setRadioAuthError("");
      } else {
        setRadioAuthError("Ongeldig token");
      }
    });
  }

  async function handleRadioSkip() {
    try {
      await apiSkipTrack();
    } catch (err) {
      console.warn("[admin] skip failed:", err);
    }
  }

  if (!authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl border border-gray-800 bg-gray-900 p-8">
          <h1 className="mb-6 text-xl font-bold text-white">Admin Login</h1>
          <form onSubmit={handleLogin} className="space-y-4">
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(""); }}
              placeholder="Wachtwoord"
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-3 text-white placeholder-gray-500 outline-none transition focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
            />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              className="w-full rounded-lg bg-violet-600 px-4 py-3 font-semibold text-white transition hover:bg-violet-500"
            >
              Inloggen
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-800 bg-gray-900/80 px-6 py-4 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold text-white">Admin Dashboard</h1>
          <div className="flex items-center gap-4">
            {activeTab === "requests" && (
              <button
                onClick={toggleAutoApprove}
                className="flex items-center gap-2 rounded-lg border border-gray-700 px-3 py-1.5 text-sm transition hover:border-gray-600"
              >
                <span
                  className={`inline-block h-3 w-3 rounded-full ${autoApprove ? "bg-green-400 shadow-sm shadow-green-400/50" : "bg-gray-600"}`}
                />
                <span className={autoApprove ? "font-semibold text-green-400" : "text-gray-400"}>
                  {autoApprove ? "AUTO AAN" : "HANDMATIG"}
                </span>
              </button>
            )}

            <button
              onClick={() => {
                sessionStorage.removeItem("admin_auth");
                clearRadioToken();
                setAuthenticated(false);
                setRadioAuthed(false);
              }}
              className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 transition hover:border-gray-600 hover:text-white"
            >
              Uitloggen
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div className="mt-3 flex gap-1 rounded-lg bg-gray-800/60 p-1">
          <button
            onClick={() => setActiveTab("requests")}
            className={`flex-1 rounded-md px-4 py-2 text-sm font-semibold transition ${
              activeTab === "requests"
                ? "bg-violet-600 text-white shadow-sm"
                : "text-gray-400 hover:text-white"
            }`}
          >
            Verzoekjes
          </button>
          <button
            onClick={() => setActiveTab("radio")}
            className={`flex-1 rounded-md px-4 py-2 text-sm font-semibold transition ${
              activeTab === "radio"
                ? "bg-violet-600 text-white shadow-sm"
                : "text-gray-400 hover:text-white"
            }`}
          >
            Radio
            {radioConnected && (
              <span className="ml-2 inline-block h-2 w-2 rounded-full bg-green-400" />
            )}
          </button>
        </div>
      </header>

      {/* Verzoekjes tab (existing) */}
      {activeTab === "requests" && (
        <main className="mx-auto max-w-4xl space-y-3 p-6">
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-gray-500">
              Audio Stream URL (Icecast)
            </label>
            <div className="flex gap-2">
              <input
                type="url"
                value={icecastUrl}
                onChange={(e) => setIcecastUrl(e.target.value)}
                placeholder="https://....trycloudflare.com/stream"
                className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none transition focus:border-violet-500"
              />
              <button
                onClick={saveIcecastUrl}
                className="shrink-0 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-500"
              >
                {icecastSaved ? "Opgeslagen!" : "Opslaan"}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-gray-500">
              {icecastUrl ? "Audio stream is actief op de website." : "Leeg = audio stream uit."}
            </p>
          </div>

          {requests.length === 0 && (
            <p className="py-20 text-center text-gray-500">Geen verzoekjes gevonden.</p>
          )}
          {requests.map((r) => (
            <AdminRequestCard key={r.id} request={r} onUpdate={loadRequests} />
          ))}
        </main>
      )}

      {/* Radio tab */}
      {activeTab === "radio" && (
        <main className="mx-auto max-w-4xl space-y-4 p-6">
          {/* Radio server URL */}
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-gray-500">
              Radio Server URL (Cloudflare Tunnel)
            </label>
            <div className="flex gap-2">
              <input
                type="url"
                value={radioServerUrl}
                onChange={(e) => setRadioServerUrl(e.target.value)}
                placeholder="https://....trycloudflare.com"
                className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none transition focus:border-violet-500"
              />
              <button
                onClick={saveRadioServerUrl}
                className="shrink-0 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-500"
              >
                {radioUrlSaved ? "Opgeslagen!" : "Opslaan"}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-gray-500">
              {radioConnected
                ? "✓ Verbonden met de radio server."
                : effectiveServerUrl
                  ? `Verbinden met ${effectiveServerUrl.slice(0, 40)}...`
                  : "Plak hier de Cloudflare Tunnel URL van je radio server."}
            </p>
          </div>

          {/* Radio admin auth */}
          {radioConnected && !radioAuthed && (
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
              <h3 className="mb-3 text-sm font-semibold text-white">Radio Admin Token</h3>
              <form onSubmit={handleRadioAuth} className="flex gap-2">
                <input
                  type="password"
                  value={radioToken}
                  onChange={(e) => { setRadioTokenState(e.target.value); setRadioAuthError(""); }}
                  placeholder="Admin token van de server"
                  className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none transition focus:border-violet-500"
                />
                <button
                  type="submit"
                  className="shrink-0 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-500"
                >
                  Verifieer
                </button>
              </form>
              {radioAuthError && <p className="mt-2 text-sm text-red-400">{radioAuthError}</p>}
            </div>
          )}

          {/* Radio admin controls */}
          {radioConnected && radioAuthed && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <ListenerCount />
                <StreamStatus />
              </div>

              {/* Keep files toggle */}
              <div className="flex items-center justify-between rounded-xl border border-gray-800 bg-gray-900 p-4">
                <div>
                  <p className="text-sm font-semibold text-white">Bestanden bewaren</p>
                  <p className="text-xs text-gray-500">
                    {keepFiles
                      ? "Audio bestanden blijven staan na afspelen"
                      : "Audio bestanden worden verwijderd na afspelen"}
                  </p>
                </div>
                <button
                  onClick={async () => {
                    try {
                      await apiSetKeepFiles(!keepFiles);
                      setKeepFiles(!keepFiles);
                    } catch (err) {
                      console.warn("[admin] keepFiles failed:", err);
                    }
                  }}
                  className="flex items-center gap-2 rounded-lg border border-gray-700 px-3 py-1.5 text-sm transition hover:border-gray-600"
                >
                  <span
                    className={`inline-block h-3 w-3 rounded-full ${keepFiles ? "bg-green-400 shadow-sm shadow-green-400/50" : "bg-gray-600"}`}
                  />
                  <span className={keepFiles ? "font-semibold text-green-400" : "text-gray-400"}>
                    {keepFiles ? "BEWAREN" : "VERWIJDEREN"}
                  </span>
                </button>
              </div>

              <ModeSelector />
              <ModeSettings />

              {/* Now playing + skip */}
              {radioTrack && (
                <div className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
                  {radioTrack.thumbnail && (
                    <img
                      src={radioTrack.thumbnail}
                      alt=""
                      className="h-14 w-20 shrink-0 rounded-lg object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Nu speelt</p>
                    <p className="truncate text-sm font-medium text-white">
                      {radioTrack.title ?? radioTrack.youtube_id}
                    </p>
                  </div>
                  <button
                    onClick={handleRadioSkip}
                    className="shrink-0 rounded-lg bg-red-600/20 px-4 py-2 text-sm font-semibold text-red-400 transition hover:bg-red-600/30"
                  >
                    Skip
                  </button>
                </div>
              )}

              <DurationVotePanel />
              <QueueAdd />
              <QueueManager />
              <PlayedHistory />
            </>
          )}
        </main>
      )}
    </div>
  );
}
