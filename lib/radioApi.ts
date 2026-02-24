import { getRadioToken } from './auth';
import { useRadioStore } from './radioStore';

export interface GenreOption {
  id: string;
  name: string;
}

export interface GenreHit {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  sourceHint: string;
}

function getServerUrl(): string | null {
  return useRadioStore.getState().serverUrl ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL ?? null;
}

async function get<T>(path: string): Promise<T> {
  const url = getServerUrl();
  if (!url) throw new Error('No server URL configured');

  const res = await fetch(`${url}${path}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as Record<string, string>).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function post(path: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const url = getServerUrl();
  if (!url) throw new Error('No server URL configured');

  const token = getRadioToken();
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, token }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const tokenHint = token ? `${token.slice(0, 4)}... (len=${token.length})` : 'NULL';
    throw new Error(`${(data as Record<string, string>).error ?? `HTTP ${res.status}`} [token=${tokenHint}, url=${url}${path}]`);
  }

  return res.json();
}

export async function setMode(mode: string): Promise<void> {
  await post('/api/mode', { mode });
  // Optimistic: re-fetch full state so store is always in sync
  refreshState();
}

export async function updateSetting(key: string, value: unknown): Promise<void> {
  await post('/api/settings', { key, value });
  refreshState();
}

export async function skipTrack(): Promise<void> {
  await post('/api/skip');
}

export async function setKeepFiles(keep: boolean): Promise<void> {
  await post('/api/keep-files', { keep });
}

export async function getGenres(query = ''): Promise<GenreOption[]> {
  const q = query.trim();
  const path = q ? `/api/genres?q=${encodeURIComponent(q)}` : '/api/genres';
  return get<GenreOption[]>(path);
}

export async function getGenreHits(genre: string, limit = 20): Promise<GenreHit[]> {
  const trimmed = genre.trim();
  if (!trimmed) return [];
  const path = `/api/genre-hits?genre=${encodeURIComponent(trimmed)}&limit=${Math.max(1, Math.min(limit, 50))}`;
  return get<GenreHit[]>(path);
}

function refreshState(): void {
  const url = getServerUrl();
  if (!url) return;

  fetch(`${url}/state`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((state) => {
      const store = useRadioStore.getState();
      store.initFromServer({
        currentTrack: state.currentTrack ?? null,
        queue: state.queue ?? [],
        mode: state.mode ?? 'radio',
        modeSettings: state.modeSettings ?? store.modeSettings,
        listenerCount: state.listenerCount ?? 0,
        streamOnline: state.streamOnline ?? false,
      });
    })
    .catch(() => {});
}
