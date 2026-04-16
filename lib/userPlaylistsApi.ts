import { useRadioStore } from './radioStore';
import { getUserIdentity } from './userIdentity';

export interface UserPlaylist {
  id: string;
  name: string;
  source: string;
  created_at: string;
  track_count?: number;
  genre_group: string | null;
  subgenre: string | null;
  related_parent_playlist_id: string | null;
  cover_url: string | null;
  owner_username: string;
  shared_with: string[];
  shared_with_count: number;
  shared_with_viewer: boolean;
  is_owner: boolean;
  viewer_can_edit: boolean;
  is_public: boolean;
  is_public_fallback: boolean;
}

export interface UserPlaylistTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  spotify_url: string | null;
  artwork_url: string | null;
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
  playlistName?: string | null,
): Promise<UserPlaylistImportResult> {
  return importUserPlaylistFiles([file], meta, playlistName);
}

export async function importUserPlaylistFiles(
  files: File[],
  meta?: PlaylistGenreMetaInput,
  playlistName?: string | null,
): Promise<UserPlaylistImportResult> {
  if (!files.length) {
    throw new Error('Geen bestanden geselecteerd');
  }
  const { nickname, deviceId } = getUserIdentity(true);
  const username = meta?.username || nickname;
  const url = `${getServerUrl()}/api/user-playlists/import`;
  const form = new FormData();
  for (const file of files) {
    form.append('files', file);
  }
  form.append('nickname', username);
  form.append('device_id', deviceId);
  const name = (playlistName ?? '').trim();
  if (name) form.append('playlist_name', name);
  if (meta?.genre_group) form.append('genre_group', meta.genre_group);
  if (meta?.subgenre) form.append('subgenre', meta.subgenre);
  if (meta?.related_parent_playlist_id) form.append('related_parent_playlist_id', meta.related_parent_playlist_id);
  if (typeof meta?.cover_url === 'string') form.append('cover_url', meta.cover_url);
  if (typeof meta?.auto_cover === 'boolean') form.append('auto_cover', meta.auto_cover ? 'true' : 'false');
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

export async function addTrackToUserPlaylist(playlistId: string, track: { title: string; artist: string | null; album?: string | null; spotify_url?: string | null; artwork_url?: string | null; position?: number }): Promise<{ ok: boolean; playlistId: string }> {
  const { nickname, deviceId } = getUserIdentity(true);
  const safeId = encodeURIComponent(playlistId);
  const res = await fetch(`${getServerUrl()}/api/user-playlists/${safeId}/tracks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, device_id: deviceId, track }),
  });
  return parseOrThrow<{ ok: boolean; playlistId: string }>(res);
}

export async function backfillUserPlaylistTrackArtwork(
  playlistId: string,
  updates: Array<{ trackId: string; artwork_url: string | null }>,
): Promise<{ ok: boolean; updated: number; skipped: number; missing: number }> {
  const { nickname, deviceId } = getUserIdentity(true);
  const safeId = encodeURIComponent(playlistId);
  const res = await fetch(`${getServerUrl()}/api/user-playlists/${safeId}/tracks/artwork-backfill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, device_id: deviceId, updates }),
  });
  return parseOrThrow<{ ok: boolean; updated: number; skipped: number; missing: number }>(res);
}

export async function removeTrackFromUserPlaylist(playlistId: string, trackId: string): Promise<{ ok: boolean }> {
  const { nickname, deviceId } = getUserIdentity(true);
  const safeId = encodeURIComponent(playlistId);
  const safeTrackId = encodeURIComponent(trackId);
  const res = await fetch(`${getServerUrl()}/api/user-playlists/${safeId}/tracks/${safeTrackId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, device_id: deviceId }),
  });
  return parseOrThrow<{ ok: boolean }>(res);
}

export async function getLikedTracksPlaylist(): Promise<{ id: string; name: string }> {
  const params = withIdentityParams();
  const res = await fetch(`${getServerUrl()}/api/user-playlists/liked-tracks?${params.toString()}`);
  return parseOrThrow<{ id: string; name: string }>(res);
}

export async function createEmptyUserPlaylist(name: string, genreGroup?: string | null): Promise<{ id: string; name: string }> {
  const { nickname, deviceId } = getUserIdentity(true);
  const res = await fetch(`${getServerUrl()}/api/user-playlists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, device_id: deviceId, name, genre_group: genreGroup }),
  });
  const data = await parseOrThrow<{ id: string; name: string; trackCount: number }>(res);
  return { id: data.id, name: data.name };
}

export async function updateUserPlaylistSharing(
  playlistId: string,
  payload: {
    share_username?: string | null;
    is_public?: boolean;
    is_public_fallback?: boolean;
  },
): Promise<UserPlaylist> {
  const { nickname, deviceId } = getUserIdentity(true);
  const safeId = encodeURIComponent(playlistId);
  const res = await fetch(`${getServerUrl()}/api/user-playlists/${safeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nickname,
      device_id: deviceId,
      ...payload,
    }),
  });
  const data = await parseOrThrow<{ ok: boolean; playlist: UserPlaylist }>(res);
  return data.playlist;
}

export async function listKnownUsers(query = "", limit = 200): Promise<string[]> {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  params.set("limit", String(limit));
  const res = await fetch(`${getServerUrl()}/api/users?${params.toString()}`);
  const data = await parseOrThrow<{ users: string[] }>(res);
  return data.users;
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
  cover_url: string | null;
  kind?: "shared" | "user_public";
  owner_username?: string | null;
  is_public_fallback?: boolean;
}

export interface PlaylistGenreMetaInput {
  genre_group?: string | null;
  subgenre?: string | null;
  related_parent_playlist_id?: string | null;
  cover_url?: string | null;
  auto_cover?: boolean | null;
  username?: string | null;
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

export async function listAllSharedPlaylists(pageSize = 250, maxPages = 20): Promise<SharedPlaylistsResponse> {
  const safePageSize = Math.max(1, Math.min(pageSize, 250));
  const safeMaxPages = Math.max(1, maxPages);
  let offset = 0;
  const items: SharedPlaylist[] = [];
  let usage: { playlists: number; tracks: number } = { playlists: 0, tracks: 0 };

  for (let page = 0; page < safeMaxPages; page += 1) {
    const result = await listSharedPlaylists(safePageSize, offset);
    usage = result.usage;
    items.push(...result.items);
    if (result.items.length < safePageSize) break;
    offset += result.items.length;
  }

  return {
    items,
    usage,
    paging: {
      limit: safePageSize,
      offset: 0,
    },
  };
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
  if (typeof meta?.cover_url === 'string') form.append('cover_url', meta.cover_url);
  if (typeof meta?.auto_cover === 'boolean') form.append('auto_cover', meta.auto_cover ? 'true' : 'false');
  const res = await fetch(`${getServerUrl()}/api/shared-playlists/import`, {
    method: "POST",
    body: form,
  });
  return parseOrThrow<SharedPlaylistImportResult>(res);
}

export async function updateSharedPlaylistAsOwner(
  playlistId: string,
  payload: {
    playlistName?: string;
    genre_group?: string | null;
    subgenre?: string | null;
    cover_url?: string | null;
    auto_cover?: boolean;
  },
): Promise<SharedPlaylist> {
  const { nickname, deviceId } = getUserIdentity(true);
  const safeId = encodeURIComponent(playlistId);
  const body: Record<string, unknown> = {
    nickname,
    device_id: deviceId,
  };
  if (payload.playlistName?.trim()) body.playlist_name = payload.playlistName.trim();
  if (Object.prototype.hasOwnProperty.call(payload, 'genre_group')) body.genre_group = payload.genre_group ?? null;
  if (Object.prototype.hasOwnProperty.call(payload, 'subgenre')) body.subgenre = payload.subgenre ?? null;
  if (Object.prototype.hasOwnProperty.call(payload, 'cover_url')) body.cover_url = payload.cover_url ?? null;
  if (typeof payload.auto_cover === 'boolean') body.auto_cover = payload.auto_cover;
  const res = await fetch(`${getServerUrl()}/api/shared-playlists/${safeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await parseOrThrow<{ ok: boolean; playlist: SharedPlaylist }>(res);
  return result.playlist;
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
    body.cover_url = meta.cover_url ?? null;
    if (typeof meta.auto_cover === 'boolean') body.auto_cover = meta.auto_cover;
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

export interface FavoriteArtist {
  mbid: string;
  name: string;
  image_url: string | null;
  country: string | null;
  added_at: string;
}

export async function listFavoriteArtists(): Promise<FavoriteArtist[]> {
  const { nickname, deviceId } = getUserIdentity(true);
  const params = new URLSearchParams();
  params.set('nickname', nickname);
  params.set('device_id', deviceId);
  const res = await fetch(`${getServerUrl()}/api/favorite-artists?${params.toString()}`);
  return parseOrThrow<FavoriteArtist[]>(res);
}

export async function addFavoriteArtist(artist: { mbid: string; name: string; image_url?: string | null; country?: string | null }): Promise<FavoriteArtist> {
  const { nickname, deviceId } = getUserIdentity(true);
  const res = await fetch(`${getServerUrl()}/api/favorite-artists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nickname,
      device_id: deviceId,
      mbid: artist.mbid,
      name: artist.name,
      image_url: artist.image_url ?? null,
      country: artist.country ?? null,
    }),
  });
  return parseOrThrow<FavoriteArtist>(res);
}

export async function removeFavoriteArtist(mbid: string): Promise<{ ok: boolean }> {
  const { nickname, deviceId } = getUserIdentity(true);
  const safeMbid = encodeURIComponent(mbid);
  const res = await fetch(`${getServerUrl()}/api/favorite-artists/${safeMbid}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, device_id: deviceId }),
  });
  return parseOrThrow<{ ok: boolean }>(res);
}

export async function isFavoriteArtist(mbid: string): Promise<boolean> {
  const { nickname, deviceId } = getUserIdentity(true);
  const safeMbid = encodeURIComponent(mbid);
  const params = new URLSearchParams();
  params.set('nickname', nickname);
  params.set('device_id', deviceId);
  const res = await fetch(`${getServerUrl()}/api/favorite-artists/${safeMbid}/check?${params.toString()}`);
  const data = await parseOrThrow<{ is_favorite: boolean }>(res);
  return data.is_favorite;
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
