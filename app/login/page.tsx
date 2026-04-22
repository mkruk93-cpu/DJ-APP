"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/authContext";

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { signIn, user, userAccount, loading, signOut } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [error, setError] = useState("");
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  const requestedRedirect = searchParams.get("redirect");
  const safeRedirect = requestedRedirect && requestedRedirect.startsWith("/") && !requestedRedirect.startsWith("//")
    ? requestedRedirect
    : null;

  useEffect(() => {
    if (user && userAccount) {
      setLoginLoading(false);
    }

    if (isClient && !loading && user && userAccount?.approved) {
      if (userAccount.username) {
        router.replace(safeRedirect ?? "/stream");
      } else {
        router.replace("/account-setup");
      }
    }
  }, [user, userAccount, loading, router, isClient, safeRedirect]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoginLoading(true);

    try {
      const { error: signInError } = await signIn(username, password);

      if (signInError) {
        setLoginLoading(false);
        if (signInError.message.includes("Invalid login credentials") || signInError.message.includes("User not found")) {
          setError("Ongeldige username of wachtwoord.");
        } else if (signInError.message.includes("Email not confirmed")) {
          setError("Bevestig eerst je email adres.");
        } else {
          setError("Inloggen mislukt: " + signInError.message);
        }
      }
    } catch (err) {
      console.error("Login error:", err);
      setError("Er is een onverwachte fout opgetreden.");
      setLoginLoading(false);
    }
  }

  if (!isClient || (loading && !user) || loginLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-white">Laden... (auth check)</div>
      </div>
    );
  }

  if (user && loading && !userAccount) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-white">Account profiel laden...</div>
      </div>
    );
  }

  if (user && !loading && !userAccount) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-8 text-center shadow-lg shadow-violet-500/5">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-600/20 text-3xl">
            ⚠️
          </div>
          <h1 className="mb-4 text-2xl font-bold tracking-tight text-white">Profiel Fout</h1>
          <p className="mb-6 text-gray-400">We konden je accountgegevens niet ophalen. Probeer het opnieuw.</p>
          <button
            onClick={async () => {
              await signOut();
              window.location.reload();
            }}
            className="w-full rounded-lg bg-red-600 px-4 py-3 font-semibold text-white transition hover:bg-red-500"
          >
            Opnieuw Proberen
          </button>
        </div>
      </div>
    );
  }

  if (user && userAccount && !userAccount.approved) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-8 text-center shadow-lg shadow-violet-500/5">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-yellow-600/20 text-3xl">
            ⏳
          </div>
          <h1 className="mb-4 text-2xl font-bold tracking-tight text-white">Account in Behandeling</h1>
          <p className="mb-6 text-gray-400">
            Je account is aangemaakt maar nog niet goedgekeurd door de admin.
            Je ontvangt een notificatie zodra je toegang krijgt.
          </p>
          <button
            onClick={async () => {
              await signOut();
              router.push("/login");
            }}
            className="w-full rounded-lg bg-violet-600 px-4 py-3 font-semibold text-white transition hover:bg-violet-500"
          >
            Uitloggen
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-8 shadow-lg shadow-violet-500/5">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-violet-600/20 text-3xl">
            🔐
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Log in op KrukkeX</h1>
          <p className="mt-1 text-sm text-gray-400">Voer je gegevens in om toegang te krijgen</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="mb-2 block text-sm font-medium text-gray-300">
              Username/Email
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Je username"
              autoComplete="username"
              required
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-3 text-white placeholder-gray-500 outline-none transition focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-2 block text-sm font-medium text-gray-300">
              Wachtwoord
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Je wachtwoord"
              autoComplete="current-password"
              required
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-3 text-white placeholder-gray-500 outline-none transition focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={loginLoading}
            className="w-full rounded-lg bg-violet-600 px-4 py-3 font-semibold text-white transition hover:bg-violet-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loginLoading ? "Inloggen..." : "Log in"}
          </button>
        </form>

        <div className="mt-6 text-center">
          <p className="text-sm text-gray-400">
            Nog geen account?{" "}
            <button
              onClick={() => router.push("/register")}
              className="text-violet-400 transition hover:text-violet-300"
            >
              Registreer
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-white">Laden... (auth check)</div>
        </div>
      }
    >
      <LoginPageInner />
    </Suspense>
  );
}
