"use client";

import { useEffect, useState, useCallback } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import { connectSocket, disconnectSocket, getSocket } from "@/lib/socket";
import { useRadioStore } from "@/lib/radioStore";
import { getRadioToken, setRadioToken, clearRadioToken } from "@/lib/auth";
import { skipTrack as apiSkipTrack, setKeepFiles as apiSetKeepFiles, updateSetting as apiUpdateSetting } from "@/lib/radioApi";
import ModeSelector from "@/components/admin/ModeSelector";
import ModeSettings from "@/components/admin/ModeSettings";
import QueueManager from "@/components/admin/QueueManager";
import QueueAdd from "@/components/QueueAdd";
import ListenerCount from "@/components/admin/ListenerCount";
import StreamStatus from "@/components/admin/StreamStatus";
import PlayedHistory from "@/components/admin/PlayedHistory";
import DurationVotePanel from "@/components/DurationVote";
import GenreManager from "@/components/admin/GenreManager";
import GenreManagerErrorBoundary from "@/components/admin/GenreManagerErrorBoundary";
import SharedPlaylistManager from "@/components/admin/SharedPlaylistManager";
import type { Track, QueueItem, Mode, ModeSettings as ModeSettingsType, VoteState, DurationVote } from "@/lib/types";

const ADMIN_PASSWORD = process.env.NEXT_PUBLIC_ADMIN_PASSWORD;

export default function AdminPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [radioServerUrl, setRadioServerUrl] = useState("");
  const [radioUrlSaved, setRadioUrlSaved] = useState(false);

  // Radio admin auth
  const [radioToken, setRadioTokenState] = useState("");
  const [radioAuthError, setRadioAuthError] = useState("");
  const [radioAuthed, setRadioAuthed] = useState(false);
  const [keepFiles, setKeepFiles] = useState(false);
  const [jingleEnabled, setJingleEnabled] = useState(true);
  const [jingleEveryTracks, setJingleEveryTracks] = useState(4);

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
            pausedForIdle: state.pausedForIdle ?? false,
            durationVote: state.durationVote ?? null,
          });
          if (typeof state.jingleEnabled === "boolean") {
            setJingleEnabled(state.jingleEnabled);
          }
          if (typeof state.jingleEveryTracks === "number" && Number.isFinite(state.jingleEveryTracks)) {
            setJingleEveryTracks(Math.max(1, Math.round(state.jingleEveryTracks)));
          }
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
    socket.on("settings:jingleChanged", (data: { enabled: boolean; everyTracks: number }) => {
      setJingleEnabled(!!data.enabled);
      setJingleEveryTracks(Math.max(1, Math.round(Number(data.everyTracks) || 4)));
    });
    socket.on("durationVote:update", (data: DurationVote & { voters: string[] }) => {
      const voted = data.voters?.includes(socket.id ?? "") ?? false;
      store.getState().setDurationVote({ ...data, voted });
    });
    socket.on("durationVote:end", () => {
      store.getState().setDurationVote(null);
    });
    socket.on("tunnel:url", (data: { url: string }) => {
      const nextUrl = (data.url ?? "").trim().replace(/\/+$/, "");
      setRadioServerUrl(nextUrl);
      store.getState().setServerUrl(nextUrl || null);
      setRadioUrlSaved(true);
      setTimeout(() => setRadioUrlSaved(false), 2000);
    });

    return () => disconnectSocket();
  }, [authenticated, effectiveServerUrl, store]);

  useEffect(() => {
    const nextUrl = radioServerUrl.trim().replace(/\/+$/, "");
    store.getState().setServerUrl(nextUrl || null);
  }, [radioServerUrl, store]);

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
      const rUrl = data.radio_server_url ?? "";
      setRadioServerUrl(rUrl);
      store.getState().setServerUrl(rUrl || null);
    }
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    loadSettings();

    const settingsInterval = setInterval(() => { loadSettings(); }, 10_000);

    return () => {
      clearInterval(settingsInterval);
    };
  }, [authenticated, loadSettings]);

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
      </header>

      <main className="mx-auto max-w-4xl space-y-4 p-6">
        <details open className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-800/60">
            DJ verzoekjes intake
            <span className="text-xs text-gray-400">Uitklappen</span>
          </summary>
          <div className="border-t border-gray-800 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-white">Moderatie</p>
                <p className="text-xs text-gray-500">
                  {autoApprove
                    ? "Automatisch binnenhalen (direct approved)"
                    : "Handmatig accepteren/afwijzen (blijft pending)"}
                </p>
              </div>
              <button
                onClick={toggleAutoApprove}
                className="flex items-center gap-2 rounded-lg border border-gray-700 px-3 py-1.5 text-sm transition hover:border-gray-600"
              >
                <span
                  className={`inline-block h-3 w-3 rounded-full ${autoApprove ? "bg-green-400 shadow-sm shadow-green-400/50" : "bg-gray-600"}`}
                />
                <span className={autoApprove ? "font-semibold text-green-400" : "text-gray-400"}>
                  {autoApprove ? "AUTOMATISCH" : "HANDMATIG"}
                </span>
              </button>
            </div>
          </div>
        </details>

        <details open className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-800/60">
            Server verbinding
            <span className="text-xs text-gray-400">Uitklappen</span>
          </summary>
          <div className="border-t border-gray-800 p-4">
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
        </details>

          {/* Radio admin auth */}
        {radioConnected && !radioAuthed && (
          <details open className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-800/60">
              Radio admin authenticatie
              <span className="text-xs text-gray-400">Uitklappen</span>
            </summary>
            <div className="border-t border-gray-800 p-4">
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
          </details>
        )}

          {/* Radio admin controls */}
        {radioConnected && radioAuthed && (
          <>
            <details open className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-800/60">
                Live status
                <span className="text-xs text-gray-400">Uitklappen</span>
              </summary>
              <div className="grid gap-4 border-t border-gray-800 p-4 sm:grid-cols-2">
                <ListenerCount />
                <StreamStatus />
              </div>
            </details>

            <details className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-800/60">
                Playback & modus instellingen
                <span className="text-xs text-gray-400">Uitklappen</span>
              </summary>
              <div className="space-y-4 border-t border-gray-800 p-4">
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
                <div className="space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-white">Jingles</p>
                      <p className="text-xs text-gray-500">
                        1 jingle na elke {jingleEveryTracks} tracks
                      </p>
                    </div>
                    <button
                      onClick={async () => {
                        const next = !jingleEnabled;
                        setJingleEnabled(next);
                        try {
                          await apiUpdateSetting("jingle_enable", next);
                        } catch (err) {
                          console.warn("[admin] jingle_enable failed:", err);
                        }
                      }}
                      className="flex items-center gap-2 rounded-lg border border-gray-700 px-3 py-1.5 text-sm transition hover:border-gray-600"
                    >
                      <span
                        className={`inline-block h-3 w-3 rounded-full ${jingleEnabled ? "bg-green-400 shadow-sm shadow-green-400/50" : "bg-gray-600"}`}
                      />
                      <span className={jingleEnabled ? "font-semibold text-green-400" : "text-gray-400"}>
                        {jingleEnabled ? "AAN" : "UIT"}
                      </span>
                    </button>
                  </div>
                  <div>
                    <label className="mb-1.5 flex items-center justify-between text-sm text-gray-300">
                      <span>Na hoeveel tracks</span>
                      <span className="font-semibold text-violet-400">{jingleEveryTracks}</span>
                    </label>
                    <input
                      type="range"
                      min={1}
                      max={20}
                      value={jingleEveryTracks}
                      onChange={(e) => {
                        const next = Math.max(1, Number(e.target.value) || 1);
                        setJingleEveryTracks(next);
                        void apiUpdateSetting("jingle_every_tracks", next).catch((err) => {
                          console.warn("[admin] jingle_every_tracks failed:", err);
                        });
                      }}
                      className="violet-slider h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
                    />
                  </div>
                </div>
                <ModeSelector />
                <ModeSettings />
              </div>
            </details>

            <details className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-800/60">
                Nu speelt & voting
                <span className="text-xs text-gray-400">Uitklappen</span>
              </summary>
              <div className="space-y-4 border-t border-gray-800 p-4">
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
              </div>
            </details>

            <details className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-800/60">
                Queue beheer
                <span className="text-xs text-gray-400">Uitklappen</span>
              </summary>
              <div className="space-y-4 border-t border-gray-800 p-4">
                <QueueAdd />
                <QueueManager />
              </div>
            </details>

            <details className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-800/60">
                Genre beheer
                <span className="text-xs text-gray-400">Uitklappen</span>
              </summary>
              <div className="border-t border-gray-800 p-4">
                <GenreManagerErrorBoundary>
                  <GenreManager />
                </GenreManagerErrorBoundary>
              </div>
            </details>

            <details className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-800/60">
                Publieke playlists beheer
                <span className="text-xs text-gray-400">Uitklappen</span>
              </summary>
              <div className="border-t border-gray-800 p-4">
                <SharedPlaylistManager />
              </div>
            </details>

            <details className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-800/60">
                Speelgeschiedenis
                <span className="text-xs text-gray-400">Uitklappen</span>
              </summary>
              <div className="border-t border-gray-800 p-4">
                <PlayedHistory />
              </div>
            </details>
          </>
        )}
      </main>
    </div>
  );
}
