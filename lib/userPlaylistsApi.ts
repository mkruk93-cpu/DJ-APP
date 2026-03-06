import { useRadioStore } from './radioStore';
import { getUserIdentity } from './userIdentity';

export interface UserPlaylist {
  id: string;
  name: string;
  source: string;
  created_at: string;
}

export interface UserPlaylistTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  spotify_url: string | null;
  position: number;
}

export interface UserPlaylistImportResult {
  ok: boolean;
  imported: Array<{ id: string; name: string; trackCount: number }>;
  totalPlaylists: number;
  totalTracks: number;
}

function getServerUrl(): string {
  const url = useRadioStore.getState().serverUrl ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL ?? null;
  if (!url) throw new Error('No server URL configured');
  return url;
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as Record<string, string>).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function withIdentityParams(): URLSearchParams {
  const { nickname, deviceId } = getUserIdentity(true);
  const params = new URLSearchParams();
  params.set('nickname', nickname);
  params.set('device_id', deviceId);
  return params;
}

export async function importUserPlaylistFile(file: File): Promise<UserPlaylistImportResult> {
  const { nickname, deviceId } = getUserIdentity(true);
  const url = `${getServerUrl()}/api/user-playlists/import`;
  const form = new FormData();
  form.append('file', file);
  form.append('nickname', nickname);
  form.append('device_id', deviceId);
  const res = await fetch(url, {
    method: 'POST',
    body: form,
  });
  return parseOrThrow<UserPlaylistImportResult>(res);
}

export async function listUserPlaylists(): Promise<UserPlaylist[]> {
  const params = withIdentityParams();
  const res = await fetch(`${getServerUrl()}/api/user-playlists?${params.toString()}`);
  return parseOrThrow<UserPlaylist[]>(res);
}

export async function getUserPlaylistTracks(playlistId: string): Promise<UserPlaylistTrack[]> {
  const params = withIdentityParams();
  const safeId = encodeURIComponent(playlistId);
  const res = await fetch(`${getServerUrl()}/api/user-playlists/${safeId}/tracks?${params.toString()}`);
  return parseOrThrow<UserPlaylistTrack[]>(res);
}

export async function deleteUserPlaylist(playlistId: string): Promise<void> {
  const params = withIdentityParams();
  const safeId = encodeURIComponent(playlistId);
  const res = await fetch(`${getServerUrl()}/api/user-playlists/${safeId}?${params.toString()}`, {
    method: 'DELETE',
  });
  await parseOrThrow<{ ok: boolean }>(res);
}

export interface SpotifyOembedResult {
  thumbnail_url: string | null;
  title: string | null;
  author_name: string | null;
}

export async function getSpotifyOembed(spotifyUrl: string): Promise<SpotifyOembedResult> {
  const params = new URLSearchParams();
  params.set('url', spotifyUrl);
  const res = await fetch(`${getServerUrl()}/api/spotify/oembed?${params.toString()}`);
  return parseOrThrow<SpotifyOembedResult>(res);
}
