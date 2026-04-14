const CLIENT_ID = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID ?? "";
const REDIRECT_URI =
  typeof window !== "undefined"
    ? `${window.location.origin}/stream`
    : "";
const SCOPES = "playlist-read-private playlist-read-collaborative user-library-read";
const TOKEN_KEY = "spotify_token";
const EXPIRY_KEY = "spotify_token_expiry";
const REFRESH_TOKEN_KEY = "spotify_refresh_token";
const VERIFIER_KEY = "spotify_code_verifier";
const TOKEN_REFRESH_BUFFER_MS = 60_000;

// ── PKCE helpers ────────────────────────────────────────────────────────────

function generateRandomString(length: number): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => possible[v % possible.length]).join("");
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  return crypto.subtle.digest("SHA-256", encoder.encode(plain));
}

function base64urlEncode(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const hashed = await sha256(verifier);
  return base64urlEncode(hashed);
}

// ── Public API ──────────────────────────────────────────────────────────────

export function isSpotifyConfigured(): boolean {
  return CLIENT_ID.length > 0;
}

export function isSpotifyConnected(): boolean {
  if (typeof window === "undefined") return false;
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return false;
  const expiry = parseTokenExpiry();
  if (!expiry) return false;
  if (Date.now() < expiry) return true;
  return !!localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function getSpotifyToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

function parseTokenExpiry(): number | null {
  if (typeof window === "undefined") return null;
  const expiryRaw = localStorage.getItem(EXPIRY_KEY);
  if (!expiryRaw) return null;
  const expiry = Number.parseInt(expiryRaw, 10);
  return Number.isFinite(expiry) ? expiry : null;
}

function shouldRefreshTokenSoon(): boolean {
  const expiry = parseTokenExpiry();
  if (!expiry) return false;
  return Date.now() >= expiry - TOKEN_REFRESH_BUFFER_MS;
}

function saveSpotifyTokens(data: { access_token?: string; expires_in?: number; refresh_token?: string }): boolean {
  if (typeof window === "undefined") return false;
  const accessToken = data.access_token ?? "";
  if (!accessToken) return false;

  localStorage.setItem(TOKEN_KEY, accessToken);
  localStorage.setItem(
    EXPIRY_KEY,
    String(Date.now() + (data.expires_in ?? 3600) * 1000),
  );
  if (data.refresh_token) {
    localStorage.setItem(REFRESH_TOKEN_KEY, data.refresh_token);
  }
  return true;
}

export async function loginWithSpotify(): Promise<void> {
  const verifier = generateRandomString(64);
  const challenge = await generateCodeChallenge(verifier);
  localStorage.setItem(VERIFIER_KEY, verifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });

  const url = `https://accounts.spotify.com/authorize?${params.toString()}`;
  const w = 460;
  const h = 700;
  const left = window.screenX + (window.innerWidth - w) / 2;
  const top = window.screenY + (window.innerHeight - h) / 2;
  window.open(url, "spotify-auth", `width=${w},height=${h},left=${left},top=${top},popup=yes`);
}

export async function handleSpotifyCallback(): Promise<boolean> {
  if (typeof window === "undefined") return false;

  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return false;

  const verifier = localStorage.getItem(VERIFIER_KEY);
  if (!verifier) return false;

  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });

    if (!res.ok) return false;

    const data = await res.json() as { access_token?: string; expires_in?: number; refresh_token?: string };
    const saved = saveSpotifyTokens(data);
    if (!saved) return false;
    localStorage.removeItem(VERIFIER_KEY);
    window.dispatchEvent(new CustomEvent("spotify:connected"));

    if (window.opener) {
      window.close();
      return true;
    }

    const url = new URL(window.location.href);
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    window.history.replaceState({}, "", url.pathname);

    return true;
  } catch {
    return false;
  }
}

export function disconnectSpotify(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRY_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(VERIFIER_KEY);
}

export async function refreshSpotifyToken(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken || !CLIENT_ID) return false;

  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) return false;
    const data = await res.json() as { access_token?: string; expires_in?: number; refresh_token?: string };
    const saved = saveSpotifyTokens(data);
    if (saved) {
      window.dispatchEvent(new CustomEvent("spotify:token_refreshed"));
    }
    return saved;
  } catch {
    return false;
  }
}

export async function spotifyFetch<T>(endpoint: string): Promise<T | null> {
  let token = getSpotifyToken();
  if (!token) return null;

  try {
    const url = endpoint.startsWith("http")
      ? endpoint
      : `https://api.spotify.com/v1${endpoint}`;

    if (shouldRefreshTokenSoon()) {
      const refreshed = await refreshSpotifyToken();
      if (refreshed) {
        token = getSpotifyToken();
      }
    }
    if (!token) return null;

    const sendWithToken = async (bearer: string) => fetch(url, {
      headers: { Authorization: `Bearer ${bearer}` },
    });

    let res = await sendWithToken(token);

    if (res.status === 401) {
      const refreshed = await refreshSpotifyToken();
      if (!refreshed) {
        disconnectSpotify();
        return null;
      }
      const retriedToken = getSpotifyToken();
      if (!retriedToken) {
        disconnectSpotify();
        return null;
      }
      res = await sendWithToken(retriedToken);
      if (res.status === 401) {
        disconnectSpotify();
        return null;
      }
    }

    if (!res.ok) {
      return null;
    }

    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ── Spotify API types ───────────────────────────────────────────────────────

export interface SpotifyImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  images: SpotifyImage[];
  tracks: { total: number };
  owner: { display_name: string };
}

export interface SpotifyArtist {
  name: string;
}

export interface SpotifyAlbum {
  name: string;
  images: SpotifyImage[];
}

export interface SpotifyTrackItem {
  id: string;
  name: string;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  duration_ms: number;
  external_urls?: {
    spotify?: string;
  };
}

export interface SpotifyPlaylistTrack {
  track: SpotifyTrackItem | null;
}

export interface SpotifyPaginatedResponse<T> {
  items: T[];
  total: number;
  next: string | null;
  offset: number;
  limit: number;
}

export interface SpotifyUser {
  display_name: string;
  id: string;
  images: SpotifyImage[];
}
