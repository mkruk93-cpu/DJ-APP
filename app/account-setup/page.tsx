"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/authContext";
import { getSupabase } from "@/lib/supabaseClient";

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;

export default function AccountSetupPage() {
  const router = useRouter();
  const { user, userAccount, refreshUserAccount } = useAuth();
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) {
      router.replace("/login");
      return;
    }

    if (userAccount?.username) {
      // User already has username, redirect to stream
      router.replace("/stream");
      return;
    }

    if (userAccount && !userAccount.approved) {
      // User not approved, redirect to login
      router.replace("/login");
      return;
    }
  }, [user, userAccount, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!USERNAME_REGEX.test(username)) {
      setError("Username moet 3-20 tekens zijn (letters, cijfers, underscores).");
      return;
    }

    setLoading(true);

    try {
      const supabase = getSupabase();

      // Check if username is already taken
      const { data: existingUser } = await supabase
        .from('user_accounts')
        .select('id')
        .eq('username', username)
        .single();

      if (existingUser) {
        setError("Deze username is al in gebruik.");
        return;
      }

      // Update user account with username
      const { error: updateError } = await supabase
        .from('user_accounts')
        .update({
          username: username,
          last_login: new Date().toISOString()
        })
        .eq('id', user!.id);

      if (updateError) throw updateError;

      // Refresh user account data
      await refreshUserAccount();

      // Redirect to stream
      router.push("/stream");

    } catch (err) {
      console.error('Error setting up account:', err);
      setError("Er is een fout opgetreden bij het instellen van je account.");
    } finally {
      setLoading(false);
    }
  }

  if (!user || !userAccount?.approved || userAccount.username) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-white">Laden...</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-8 shadow-lg shadow-violet-500/5">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-green-600/20 text-3xl">
            ✓
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Account Instellen
          </h1>
          <p className="mt-1 text-sm text-gray-400">
            Je account is goedgekeurd! Kies een username om verder te gaan.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="block text-sm font-medium text-gray-300 mb-2">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Jouw username"
              maxLength={20}
              required
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-3 text-white placeholder-gray-500 outline-none transition focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              3-20 tekens, alleen letters, cijfers en underscores
            </p>
          </div>

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-violet-600 px-4 py-3 font-semibold text-white transition hover:bg-violet-500 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Instellen..." : "Account Instellen"}
          </button>
        </form>
      </div>
    </div>
  );
}