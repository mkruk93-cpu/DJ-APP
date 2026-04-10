"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
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
import { useAuth } from "@/lib/authContext";
import type { Track, QueueItem, Mode, ModeSettings as ModeSettingsType, VoteState, DurationVote } from "@/lib/types";

const ADMIN_PASSWORD = process.env.NEXT_PUBLIC_ADMIN_PASSWORD || "admin";

interface AdminJingleItem {
  key: string;
  name: string;
  title: string;
  duration: number | null;
  selected: boolean;
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function AdminPage() {
  const { user, userAccount } = useAuth();
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [radioServerUrl, setRadioServerUrl] = useState("");
  const [radioUrlSaved, setRadioUrlSaved] = useState(false);
  const [userApprovals, setUserApprovals] = useState<any[]>([]);
  const [approvalsLoading, setApprovalsLoading] = useState(false);
  const [radioToken, setRadioTokenState] = useState("");
  const [radioAuthError, setRadioAuthError] = useState("");
  const [radioAuthed, setRadioAuthed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [keepFiles, setKeepFiles] = useState(false);
  const [jingleEnabled, setJingleEnabled] = useState(true);
  const [jingleEveryTracks, setJingleEveryTracks] = useState(4);
  const [jingleItems, setJingleItems] = useState<AdminJingleItem[]>([]);
  const [jingleLoading, setJingleLoading] = useState(false);
  const [pushMessage, setPushMessageState] = useState("");
  const [pushExpiryMinutes, setPushExpiryMinutes] = useState(0);
  const [pushSending, setPushSending] = useState(false);
  const [pushError, setPushError] = useState("");

  const radioConnected = useRadioStore((s) => s.connected);
  const radioTrack = useRadioStore((s) => s.currentTrack);
  const lockAutoplayFallback = useRadioStore((s) => s.lockAutoplayFallback);
  const hideLocalDiscovery = useRadioStore((s) => s.hideLocalDiscovery);
  const store = useRadioStore;

  const embedded = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("embed") === "1";
  }, []);

  const effectiveServerUrl = radioServerUrl || process.env.NEXT_PUBLIC_CONTROL_SERVER_URL || "";

  // All hooks must be called before any early returns - collect them here first
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (sessionStorage.getItem("admin_auth") === "true") {
      setAuthenticated(true);
    }
    const token = getRadioToken();
    if (token) {
      setRadioTokenState(token);
      setRadioAuthed(true);
    }
  }, []);

  useEffect(() => {
    const token = getRadioToken();
    if (token && token !== radioToken) {
      setRadioTokenState(token);
    }
  }, [radioToken]);

  useEffect(() => {
    const username = (userAccount?.username ?? "").trim().toLowerCase();
    if (username === "krukkex") {
      setAuthenticated(true);
      sessionStorage.setItem("admin_auth", "true");
    }
  }, [userAccount?.username]);

  const loadUserApprovals = useCallback(async () => {
    setApprovalsLoading(true);
    try {
      const { data, error } = await getSupabase()
        .from('user_approvals')
        .select('*')
        .eq('approved', false)
        .eq('rejected', false)
        .order('requested_at', { ascending: false });

      if (error) throw error;
      setUserApprovals(data || []);
    } catch (err) {
      console.error('Error loading user approvals:', err);
    } finally {
      setApprovalsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authenticated) {
      loadUserApprovals();
    }
  }, [authenticated, loadUserApprovals]);

  useEffect(() => {
    if (!authenticated || radioAuthed) return;
    const token = ADMIN_PASSWORD ?? "";
    setRadioToken(token);
    setRadioAuthed(true);
  }, [authenticated, radioAuthed]);

  // All hooks are now above - render normally (SSR will handle itself)
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
            lockAutoplayFallback: state.lockAutoplayFallback ?? false,
            hideLocalDiscovery: state.hideLocalDiscovery ?? false,
          });
          if (typeof state.jingleEnabled === "boolean") {
            setJingleEnabled(state.jingleEnabled);
          }
          if (typeof state.jingleEveryTracks === "number" && Number.isFinite(state.jingleEveryTracks)) {
            setJingleEveryTracks(Math.max(1, Math.round(state.jingleEveryTracks)));
          }
          if (Array.isArray(state.jingleSelectedKeys)) {
            const selected = new Set(state.jingleSelectedKeys.map((entry: unknown) => String(entry).toLowerCase()));
            setJingleItems((prev) => prev.map((item) => ({ ...item, selected: selected.size === 0 ? true : selected.has(item.key.toLowerCase()) })));
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
      const username = userAccount?.username;
      if (username) {
        socket.emit("listener:state", { nickname: username, listening: true });
      }
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
    socket.on("stream:status", (data: { online: boolean; listeners: number; pausedForIdle?: boolean }) => {
      store.getState().setStreamOnline(data.online);
      store.getState().setListenerCount(data.listeners);
      if (typeof data.pausedForIdle === "boolean") {
        store.getState().setPausedForIdle(data.pausedForIdle);
      }
    });
    socket.on("error:toast", (data: { message: string }) => {
      console.warn("[radio admin]", data.message);
    });
    socket.on("settings:keepFilesChanged", (data: { keep: boolean }) => {
      setKeepFiles(data.keep);
    });
    socket.on("settings:jingleChanged", (data: { enabled: boolean; everyTracks: number; selectedKeys?: string[] }) => {
      setJingleEnabled(!!data.enabled);
      setJingleEveryTracks(Math.max(1, Math.round(Number(data.everyTracks) || 4)));
      if (Array.isArray(data.selectedKeys)) {
        const selected = new Set(data.selectedKeys.map((entry) => String(entry).toLowerCase()));
        setJingleItems((prev) => prev.map((item) => ({ ...item, selected: selected.size === 0 ? true : selected.has(item.key.toLowerCase()) })));
      }
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

  // Sync nickname with server for admin rights
  useEffect(() => {
    if (!authenticated || !userAccount?.username) return;
    const socket = getSocket();
    
    const emitState = () => {
      socket.emit("listener:state", { 
        nickname: userAccount.username,
        listening: false // Admin page doesn't count as listening
      });
    };

    if (socket.connected) {
      emitState();
    }

    socket.on("connect", emitState);
    return () => {
      socket.off("connect", emitState);
    };
  }, [authenticated, userAccount?.username]);

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

  const loadJingles = useCallback(async () => {
    if (!effectiveServerUrl || !radioAuthed) return;
    const token = getRadioToken();
    if (!token) return;
    setJingleLoading(true);
    try {
      const res = await fetch(`${effectiveServerUrl}/api/jingles?token=${encodeURIComponent(token)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as {
        items?: AdminJingleItem[];
        selectedKeys?: string[];
        everyTracks?: number;
        enabled?: boolean;
      };
      const items = Array.isArray(payload.items) ? payload.items : [];
      setJingleItems(items);
      if (typeof payload.enabled === "boolean") setJingleEnabled(payload.enabled);
      if (typeof payload.everyTracks === "number" && Number.isFinite(payload.everyTracks)) {
        setJingleEveryTracks(Math.max(1, Math.round(payload.everyTracks)));
      }
    } catch (err) {
      console.warn("[admin] loadJingles failed:", err);
    } finally {
      setJingleLoading(false);
    }
  }, [effectiveServerUrl, radioAuthed]);

  useEffect(() => {
    if (!authenticated) return;
    loadSettings();

    const settingsInterval = setInterval(() => { loadSettings(); }, 10_000);

    return () => {
      clearInterval(settingsInterval);
    };
  }, [authenticated, loadSettings]);

  useEffect(() => {
    if (!authenticated || !radioAuthed) return;
    void loadJingles();
    const timer = setInterval(() => { void loadJingles(); }, 20_000);
    return () => clearInterval(timer);
  }, [authenticated, radioAuthed, loadJingles]);

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

  async function approveUser(approvalId: string, userId: string) {
    try {
      const supabase = getSupabase();
      
      // Update approval
      const { error: approvalError } = await supabase
        .from('user_approvals')
        .update({
          approved: true,
          approved_at: new Date().toISOString(),
          approved_by: userAccount?.username || 'admin'
        })
        .eq('id', approvalId);

      if (approvalError) throw approvalError;

      // Update user account (it should already exist from signup)
      const { error: accountError } = await supabase
        .from('user_accounts')
        .update({
          approved: true,
          approved_at: new Date().toISOString(),
          approved_by: userAccount?.username || 'admin'
        })
        .eq('id', userId);

      if (accountError) throw accountError;

      // Reload approvals
      await loadUserApprovals();
    } catch (err) {
      console.error('Error approving user:', err);
      alert('Fout bij goedkeuren gebruiker');
    }
  }

  async function rejectUser(approvalId: string, userId: string) {
    try {
      const supabase = getSupabase();

      // 1. Verwijder data uit de database
      const { error: approvalError } = await supabase
        .from('user_approvals')
        .delete()
        .eq('id', approvalId);

      if (approvalError) throw approvalError;

      // 2. Verwijder het profiel
      const { error: accountError } = await supabase
        .from('user_accounts')
        .delete()
        .eq('id', userId);

      if (accountError) {
        console.warn('Kon user_account niet verwijderen (mogelijk bestaat deze niet):', accountError);
        alert('Let op: Het profiel (user_accounts) kon niet volledig worden verwijderd. Mogelijk heeft deze gebruiker al data (chats/requests) gekoppeld. De gebruiker is hierdoor nog niet weg.');
      }

      // 3. Verwijder de login (Auth User) via de server API
      // Dit voorkomt dat de gebruiker ingelogd blijft en het profiel automatisch terugkomt.
      const res = await fetch('/api/admin/delete-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          userId, 
          secret: ADMIN_PASSWORD 
        })
      });

      if (!res.ok) {
        console.error('Kon auth user niet verwijderen via API');
        const data = await res.json();
        alert('Let op: Data is weg, maar login account kon niet verwijderd worden: ' + (data.error || 'Onbekend'));
      }

      // Reload approvals
      await loadUserApprovals();
    } catch (err) {
      console.error('Error deleting user data:', err);
      alert('Fout bij verwijderen gegevens');
    }
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
      {!embedded && (
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
      )}

      <main className={`mx-auto max-w-4xl space-y-4 ${embedded ? "p-2" : "p-6"}`}>
        <details open className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-800/60">
            Gebruiker Goedkeuringen
            <span className="text-xs text-gray-400">Uitklappen</span>
          </summary>
          <div className="border-t border-gray-800 p-4">
            {approvalsLoading ? (
              <p className="text-sm text-gray-400">Laden...</p>
            ) : userApprovals.length === 0 ? (
              <p className="text-sm text-gray-400">Geen pending goedkeuringen.</p>
            ) : (
              <div className="space-y-3">
                {userApprovals.map((approval) => (
                  <div key={approval.id} className="flex items-center justify-between rounded-lg border border-gray-700 bg-gray-800 p-3">
                    <div>
                      <p className="text-sm font-medium text-white">{approval.email}</p>
                      <p className="text-xs text-gray-400">
                        Aangevraagd: {new Date(approval.requested_at).toLocaleString('nl-NL')}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => approveUser(approval.id, approval.user_id)}
                        className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-green-500"
                      >
                        Goedkeuren
                      </button>
                      <button
                        onClick={() => {
                          if (confirm('Weet je zeker dat je deze aanvraag wilt verwijderen? Alle gegevens worden gewist.')) {
                            rejectUser(approval.id, approval.user_id);
                          }
                        }}
                        className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-red-500"
                      >
                        Afwijzen
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>

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
        {!radioAuthed && (
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
        {radioAuthed && (
          <>
            {!radioConnected && (
              <div className="rounded-xl border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">
                Radio server is nu niet live verbonden; instellingen (zoals jingles) blijven wel beschikbaar via de control API.
              </div>
            )}
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

            {/* Push notification */}
            <details open className="overflow-hidden rounded-xl border border-amber-900/40 bg-amber-950/20">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-amber-200 transition hover:bg-amber-900/30">
                <span className="flex items-center gap-2">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                  Push bericht sturen
                </span>
                <span className="text-xs text-amber-400/70">Uitklappen</span>
              </summary>
              <div className="space-y-3 border-t border-amber-900/30 p-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-amber-200/80">
                    Bericht
                  </label>
                  <textarea
                    value={pushMessage}
                    onChange={(e) => setPushMessageState(e.target.value)}
                    placeholder="Typ een bericht voor alle luisteraars..."
                    rows={3}
                    className="w-full rounded-lg border border-amber-700/50 bg-amber-950/50 px-3 py-2 text-sm text-amber-100 placeholder-amber-700/50 outline-none transition focus:border-amber-500"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-amber-200/80">Vervalt na:</label>
                    <select
                      value={pushExpiryMinutes}
                      onChange={(e) => setPushExpiryMinutes(Number(e.target.value))}
                      className="rounded-lg border border-amber-700/50 bg-amber-950/50 px-2 py-1 text-xs text-amber-100 outline-none transition focus:border-amber-500"
                    >
                      <option value={0}>Nooit</option>
                      <option value={5}>5 minuten</option>
                      <option value={15}>15 minuten</option>
                      <option value={30}>30 minuten</option>
                      <option value={60}>1 uur</option>
                      <option value={120}>2 uur</option>
                      <option value={240}>4 uur</option>
                    </select>
                  </div>
                  <button
                    onClick={() => {
                      if (!pushMessage.trim()) {
                        setPushError("Vul een bericht in");
                        return;
                      }
                      setPushSending(true);
                      setPushError("");
                      
                      const socket = getSocket();
                      const tokenToUse = getRadioToken() || radioToken;
                      socket.emit('push:send', {
                        message: pushMessage.trim(),
                        expiryMinutes: pushExpiryMinutes,
                        token: tokenToUse,
                      });
                      
                      socket.once('push:message', (data: { message: string | null }) => {
                        setPushSending(false);
                        if (data.message) {
                          setPushMessageState("");
                          setPushExpiryMinutes(0);
                          setPushError("");
                        }
                      });
                      
                      socket.once('error:toast', (data: { message: string }) => {
                        setPushSending(false);
                        setPushError(data.message || "Fout bij versturen");
                      });
                      
                      setTimeout(() => {
                        setPushSending(false);
                      }, 5000);
                    }}
                    disabled={pushSending || !pushMessage.trim() || !radioConnected}
                    className="ml-auto rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-amber-500 disabled:opacity-50"
                  >
                    {pushSending ? "Versturen..." : "Bericht sturen"}
                  </button>
                </div>
                {pushError && <p className="text-xs text-red-400">{pushError}</p>}
                {!radioConnected && (
                  <p className="text-[10px] text-amber-400/60">
                    Verbind eerst met de radio server via het URL veld hierboven.
                  </p>
                )}
                <p className="text-[10px] text-amber-400/60">
                  Alle luisteraars (online of die binnen de vervaltijd online komen) ontvangen dit bericht. Het verdwijnt pas als ze het zelf weg klikken.
                </p>
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
                <div className="space-y-3 rounded-xl border border-amber-900/40 bg-amber-950/20 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">Autoplay fallback vergrendelen</p>
                      <p className="text-xs text-gray-500">
                        {lockAutoplayFallback
                          ? "Alleen met radio admin-token kan het actieve autoplay-pad (genre / online / playlists) gewijzigd worden."
                          : "Iedereen met de stream kan het autoplay-pad wijzigen."}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        const next = !lockAutoplayFallback;
                        try {
                          await apiUpdateSetting("lock_autoplay_fallback", next);
                        } catch (err) {
                          console.warn("[admin] lock_autoplay_fallback failed:", err);
                        }
                      }}
                      className="flex shrink-0 items-center gap-2 rounded-lg border border-gray-700 px-3 py-1.5 text-sm transition hover:border-gray-600"
                    >
                      <span
                        className={`inline-block h-3 w-3 rounded-full ${lockAutoplayFallback ? "bg-amber-400 shadow-sm shadow-amber-400/50" : "bg-gray-600"}`}
                      />
                      <span className={lockAutoplayFallback ? "font-semibold text-amber-200" : "text-gray-400"}>
                        {lockAutoplayFallback ? "VERGRENDELD" : "VRIJ"}
                      </span>
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-amber-900/30 pt-3">
                    <div>
                      <p className="text-sm font-semibold text-white">Lokale discovery verbergen</p>
                      <p className="text-xs text-gray-500">
                        {hideLocalDiscovery
                          ? "Lokale genres en zoekresultaten zijn uitgezet (YouTube/SoundCloud-zoek en autoplay)."
                          : "Lokale map-genres en lokale zoekresultaten zijn zichtbaar."}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        const next = !hideLocalDiscovery;
                        try {
                          await apiUpdateSetting("hide_local_discovery", next);
                        } catch (err) {
                          console.warn("[admin] hide_local_discovery failed:", err);
                        }
                      }}
                      className="flex shrink-0 items-center gap-2 rounded-lg border border-gray-700 px-3 py-1.5 text-sm transition hover:border-gray-600"
                    >
                      <span
                        className={`inline-block h-3 w-3 rounded-full ${hideLocalDiscovery ? "bg-amber-400 shadow-sm shadow-amber-400/50" : "bg-gray-600"}`}
                      />
                      <span className={hideLocalDiscovery ? "font-semibold text-amber-200" : "text-gray-400"}>
                        {hideLocalDiscovery ? "VERBORGEN" : "ZICHTBAAR"}
                      </span>
                    </button>
                  </div>
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
                  <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Kies jingles</p>
                      <button
                        type="button"
                        onClick={() => { void loadJingles(); }}
                        className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 transition hover:border-gray-600 hover:text-white"
                      >
                        Ververs
                      </button>
                    </div>
                    {jingleLoading ? (
                      <p className="text-xs text-gray-500">Jingles laden...</p>
                    ) : jingleItems.length === 0 ? (
                      <p className="text-xs text-gray-500">Geen jingle-bestanden gevonden in de jingle map.</p>
                    ) : (
                      <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
                        {jingleItems.map((item) => (
                          <label
                            key={item.key}
                            className="flex cursor-pointer items-center justify-between rounded-md border border-gray-800 bg-gray-900/70 px-2 py-1.5 text-xs text-gray-200"
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {item.title || item.name}
                              <span className="ml-1 text-gray-500">({formatDuration(item.duration)})</span>
                            </span>
                            <input
                              type="checkbox"
                              checked={item.selected}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                const nextItems = jingleItems.map((row) => row.key === item.key ? { ...row, selected: checked } : row);
                                setJingleItems(nextItems);
                                const selectedKeys = nextItems.filter((row) => row.selected).map((row) => row.key);
                                void apiUpdateSetting("jingle_selected_keys", selectedKeys).catch((err) => {
                                  console.warn("[admin] jingle_selected_keys failed:", err);
                                });
                              }}
                              className="h-4 w-4 accent-violet-500"
                            />
                          </label>
                        ))}
                      </div>
                    )}
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
