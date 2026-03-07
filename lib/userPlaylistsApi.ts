import { useRadioStore } from './radioStore';
import { getUserIdentity } from './userIdentity';

export interface UserPlaylist {
  id: string;
  name: string;
  source: string;
  created_at: string;
  genre_group: string | null;
  subgenre: string | null;
  related_parent_playlist_id: string | null;
}

export interface UserPlaylistTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  spotify_url: string | null;
  position: number;
}

export interface PlaylistTrackPage {
  items: UserPlaylistTrack[];
  paging: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface UserPlaylistImportResult {
  ok: boolean;
  imported: Array<{ id: string; name: string; trackCount: number }>;
  totalPlaylists: number;
  totalTracks: number;
  shared?: {
    importedPlaylists: number;
    warnings: Array<{ name: string; reason: string }>;
    usage: { playlists: number; tracks: number };
  };
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

export async function importUserPlaylistFile(
  file: File,
  meta?: PlaylistGenreMetaInput,
): Promise<UserPlaylistImportResult> {
  const { nickname, deviceId } = getUserIdentity(true);
  const url = `${getServerUrl()}/api/user-playlists/import`;
  const form = new FormData();
  form.append('file', file);
  form.append('nickname', nickname);
  form.append('device_id', deviceId);
  if (meta?.genre_group) form.append('genre_group', meta.genre_group);
  if (meta?.subgenre) form.append('subgenre', meta.subgenre);
  if (meta?.related_parent_playlist_id) form.append('related_parent_playlist_id', meta.related_parent_playlist_id);
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

export async function getUserPlaylistTracksPage(
  playlistId: string,
  limit = 120,
  offset = 0,
): Promise<PlaylistTrackPage> {
  const params = withIdentityParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  const safeId = encodeURIComponent(playlistId);
  const res = await fetch(`${getServerUrl()}/api/user-playlists/${safeId}/tracks?${params.toString()}`);
  return parseOrThrow<PlaylistTrackPage>(res);
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

export interface SharedPlaylist {
  id: string;
  name: string;
  source: string;
  created_at: string;
  imported_at: string;
  track_count: number;
  added_by: string | null;
  genre_group: string | null;
  subgenre: string | null;
  related_parent_playlist_id: string | null;
}

export interface PlaylistGenreMetaInput {
  genre_group?: string | null;
  subgenre?: string | null;
  related_parent_playlist_id?: string | null;
}

export interface SharedPlaylistsResponse {
  items: SharedPlaylist[];
  usage: { playlists: number; tracks: number };
  paging: { limit: number; offset: number };
}

export interface SharedPlaylistImportResult {
  ok: boolean;
  playlist: { id: string; name: string; trackCount: number };
  usage: { playlists: number; tracks: number };
}

export async function listSharedPlaylists(limit = 100, offset = 0): Promise<SharedPlaylistsResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  const res = await fetch(`${getServerUrl()}/api/shared-playlists?${params.toString()}`);
  return parseOrThrow<SharedPlaylistsResponse>(res);
}

export async function getSharedPlaylistTracks(playlistId: string): Promise<UserPlaylistTrack[]> {
  const safeId = encodeURIComponent(playlistId);
  const res = await fetch(`${getServerUrl()}/api/shared-playlists/${safeId}/tracks`);
  return parseOrThrow<UserPlaylistTrack[]>(res);
}

export async function getSharedPlaylistTracksPage(
  playlistId: string,
  limit = 120,
  offset = 0,
): Promise<PlaylistTrackPage> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  const safeId = encodeURIComponent(playlistId);
  const res = await fetch(`${getServerUrl()}/api/shared-playlists/${safeId}/tracks?${params.toString()}`);
  return parseOrThrow<PlaylistTrackPage>(res);
}

export async function importSharedPlaylistFiles(
  files: File[],
  playlistName: string,
  meta?: PlaylistGenreMetaInput,
): Promise<SharedPlaylistImportResult> {
  if (!files.length) {
    throw new Error("Geen bestanden geselecteerd");
  }
  const { nickname, deviceId } = getUserIdentity(true);
  const form = new FormData();
  for (const file of files) {
    form.append("files", file);
  }
  form.append("playlist_name", playlistName);
  form.append("nickname", nickname);
  form.append("device_id", deviceId);
  if (meta?.genre_group) form.append('genre_group', meta.genre_group);
  if (meta?.subgenre) form.append('subgenre', meta.subgenre);
  if (meta?.related_parent_playlist_id) form.append('related_parent_playlist_id', meta.related_parent_playlist_id);
  const res = await fetch(`${getServerUrl()}/api/shared-playlists/import`, {
    method: "POST",
    body: form,
  });
  return parseOrThrow<SharedPlaylistImportResult>(res);
}

export async function updateSharedPlaylistAdmin(
  playlistId: string,
  playlistName: string,
  token: string,
  meta?: PlaylistGenreMetaInput,
): Promise<SharedPlaylist> {
  const safeId = encodeURIComponent(playlistId);
  const body: Record<string, unknown> = { token };
  if (playlistName.trim()) body.playlist_name = playlistName;
  if (meta) {
    body.genre_group = meta.genre_group ?? null;
    body.subgenre = meta.subgenre ?? null;
    body.related_parent_playlist_id = meta.related_parent_playlist_id ?? null;
  }
  const res = await fetch(`${getServerUrl()}/api/shared-playlists/${safeId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await parseOrThrow<{ ok: boolean; playlist: SharedPlaylist }>(res);
  return payload.playlist;
}

export async function deleteSharedPlaylistAdmin(
  playlistId: string,
  token: string,
): Promise<{ playlists: number; tracks: number }> {
  const safeId = encodeURIComponent(playlistId);
  const res = await fetch(`${getServerUrl()}/api/shared-playlists/${safeId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const payload = await parseOrThrow<{ ok: boolean; usage: { playlists: number; tracks: number } }>(res);
  return payload.usage;
}

export async function importIntoSharedPlaylistAdmin(
  playlistId: string,
  files: File[],
  token: string,
): Promise<{ playlist: SharedPlaylist; usage: { playlists: number; tracks: number } }> {
  if (!files.length) {
    throw new Error('Geen bestanden geselecteerd');
  }
  const safeId = encodeURIComponent(playlistId);
  const form = new FormData();
  for (const file of files) {
    form.append('files', file);
  }
  form.append('token', token);
  const res = await fetch(`${getServerUrl()}/api/shared-playlists/${safeId}/import`, {
    method: 'POST',
    body: form,
  });
  const payload = await parseOrThrow<{ ok: boolean; playlist: SharedPlaylist; usage: { playlists: number; tracks: number } }>(res);
  return { playlist: payload.playlist, usage: payload.usage };
}

export async function deleteSharedPlaylistTrackAdmin(
  playlistId: string,
  trackId: string,
  token: string,
): Promise<{ playlist: SharedPlaylist; usage: { playlists: number; tracks: number } }> {
  const safePlaylistId = encodeURIComponent(playlistId);
  const safeTrackId = encodeURIComponent(trackId);
  const res = await fetch(`${getServerUrl()}/api/shared-playlists/${safePlaylistId}/tracks/${safeTrackId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const payload = await parseOrThrow<{ ok: boolean; playlist: SharedPlaylist; usage: { playlists: number; tracks: number } }>(res);
  return { playlist: payload.playlist, usage: payload.usage };
}
