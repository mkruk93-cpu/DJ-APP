"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, AuthProvider } from "@/lib/authContext";
import { getSupabase } from "@/lib/supabaseClient";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;

export default function RegisterPage() {
  return (
    <AuthProvider>
      <RegisterContent />
    </AuthProvider>
  );
}

function RegisterContent() {
  const router = useRouter();
  const { signUp } = useAuth();
  const [username, setUsername] = useState("");
  const [realName, setRealName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess(false);

    if (!username || !realName) {
      setError("Vul alle velden in.");
      return;
    }
    
    if (!USERNAME_REGEX.test(username)) {
      setError("Username mag alleen letters, cijfers en underscores (_) bevatten, en moet 3-20 tekens lang zijn.");
      return;
    }

    if (!EMAIL_REGEX.test(email)) {
      setError("Voer een geldig email adres in.");
      return;
    }

    if (password.length < 8) {
      setError("Wachtwoord moet minimaal 8 tekens bevatten.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Wachtwoorden komen niet overeen.");
      return;
    }

    if (!agreed) {
      setError("Je moet akkoord gaan met de voorwaarden om een account aan te vragen.");
      return;
    }

    setLoading(true);

    try {
      const supabase = getSupabase();

      // Check if username is taken
      const { data: existingUser } = await supabase
        .from('user_accounts')
        .select('id')
        .eq('username', username)
        .single();

      if (existingUser) {
        setError("Deze username is al in gebruik. Kies een andere.");
        setLoading(false);
        return;
      }
      
      // Check if email already exists in approvals
      const { data: existingApproval } = await supabase
        .from('user_approvals')
        .select('id')
        .eq('email', email.toLowerCase())
        .single();

      if (existingApproval) {
        setError("Er is al een registratieverzoek voor dit email adres. Wacht op goedkeuring door de admin.");
        setLoading(false);
        return;
      }

      // Sign up with Supabase Auth
      const { error: signUpError } = await signUp(email, password, username, realName);

      if (signUpError) {
        if (signUpError.message.includes('already registered')) {
          setError("Dit email adres is al geregistreerd.");
        } else {
          setError("Er is een fout opgetreden bij het registreren: " + signUpError.message);
        }
        return;
      }

      setSuccess(true);
      setError("");

    } catch (err) {
      console.error('Registration error:', err);
      setError("Er is een onverwachte fout opgetreden.");
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-8 shadow-lg shadow-violet-500/5 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-600/20 text-3xl">
            ✓
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white mb-4">
            Registratie Verzoek Verzonden
          </h1>
          <p className="text-gray-400 mb-6">
            Je registratieverzoek is ontvangen. De admin moet je account eerst goedkeuren voordat je kunt inloggen.
          </p>
          <button
            onClick={() => router.push('/login')}
            className="w-full rounded-lg bg-violet-600 px-4 py-3 font-semibold text-white transition hover:bg-violet-500"
          >
            Naar Login Pagina
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
            📝
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Registreer voor Toegang
          </h1>
          <p className="mt-1 text-sm text-gray-400">
            Vul je gegevens in om toegang aan te vragen
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
              placeholder="Kies een unieke username"
              autoComplete="username"
              required
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-3 text-white placeholder-gray-500 outline-none transition focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
            />
          </div>

          <div>
            <label htmlFor="realName" className="block text-sm font-medium text-gray-300 mb-2">
              Echte Voornaam
            </label>
            <input
              id="realName"
              type="text"
              value={realName}
              onChange={(e) => setRealName(e.target.value)}
              placeholder="Je voornaam"
              autoComplete="given-name"
              required
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-3 text-white placeholder-gray-500 outline-none transition focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
            />
          </div>
          
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-2">
              Email Adres
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jouw@email.nl"
              autoComplete="email"
              required
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-3 text-white placeholder-gray-500 outline-none transition focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-300 mb-2">
              Wachtwoord
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Minimaal 8 tekens"
              autoComplete="new-password"
              required
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-3 text-white placeholder-gray-500 outline-none transition focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
            />
          </div>

          <div>
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-300 mb-2">
              Bevestig Wachtwoord
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Herhaal wachtwoord"
              autoComplete="new-password"
              required
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-3 text-white placeholder-gray-500 outline-none transition focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
            />
          </div>

          <div className="flex items-start gap-2 pt-1">
            <input
              id="terms"
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-violet-500"
            />
            <label htmlFor="terms" className="text-xs text-gray-400 leading-relaxed cursor-pointer">
              Ik ga akkoord met de voorwaarden en begrijp dat het gebruik van deze dienst volledig op eigen risico is en uitsluitend voor privédoeleinden.
            </label>
          </div>

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-violet-600 px-4 py-3 font-semibold text-white transition hover:bg-violet-500 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Registreren..." : "Vraag Toegang Aan"}
          </button>
        </form>

        <div className="mt-6 text-center">
          <p className="text-sm text-gray-400">
            Al een account?{" "}
            <button
              onClick={() => router.push('/login')}
              className="text-violet-400 hover:text-violet-300 transition"
            >
              Log in
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}