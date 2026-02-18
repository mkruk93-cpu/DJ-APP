"use client";

import { useEffect, useState, useCallback } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import AdminRequestCard from "@/components/AdminRequestCard";

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

export default function AdminPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [requests, setRequests] = useState<Request[]>([]);
  const [autoApprove, setAutoApprove] = useState(false);
  const [icecastUrl, setIcecastUrl] = useState("");
  const [icecastSaved, setIcecastSaved] = useState(false);

  useEffect(() => {
    if (sessionStorage.getItem("admin_auth") === "true") {
      setAuthenticated(true);
    }
  }, []);

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
    const { data } = await getSupabase()
      .from("settings")
      .select("auto_approve, icecast_url")
      .eq("id", 1)
      .single();
    if (data) {
      setAutoApprove(data.auto_approve);
      setIcecastUrl(data.icecast_url ?? "");
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
      <header className="flex items-center justify-between border-b border-gray-800 bg-gray-900/80 px-6 py-4 backdrop-blur-sm">
        <h1 className="text-lg font-bold text-white">Admin Dashboard</h1>
        <div className="flex items-center gap-4">
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

          <button
            onClick={() => {
              sessionStorage.removeItem("admin_auth");
              setAuthenticated(false);
            }}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 transition hover:border-gray-600 hover:text-white"
          >
            Uitloggen
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-3 p-6">
        {/* Icecast URL setting */}
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
    </div>
  );
}
