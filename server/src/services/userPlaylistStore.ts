import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface StoreTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  spotify_url: string | null;
  artwork_url: string | null;
  position: number;
}

interface StorePlaylist {
  id: string;
  nickname: string;
  device_id: string;
  name: string;
  source: string;
  created_at: string;
  genre_group: string | null;
  subgenre: string | null;
  related_parent_playlist_id: string | null;
  cover_url: string | null;
  shared_with: string[];
  is_public: boolean;
  is_public_fallback: boolean;
  tracks: StoreTrack[];
}

interface StoreShape {
  playlists: StorePlaylist[];
  favorite_artists: FavoriteArtist[];
}

export interface FavoriteArtist {
  id: string;
  mbid: string;
  name: string;
  image_url: string | null;
  country: string | null;
  added_at: string;
}

export interface PlaylistOwner {
  nickname: string;
  deviceId: string;
}

export interface CreatePlaylistInputTrack {
  title: string;
  artist: string | null;
  album: string | null;
  spotify_url: string | null;
  artwork_url?: string | null;
  position: number;
}

export interface PlaylistSummary {
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

export interface PlaylistGenreMeta {
  genre_group: string | null;
  subgenre: string | null;
  related_parent_playlist_id: string | null;
  cover_url?: string | null;
}

export interface PlaylistUsage {
  playlists: number;
  tracks: number;
}

export interface PlaylistTrackPage {
  items: Array<{
    id: string;
    title: string;
    artist: string | null;
    album: string | null;
    spotify_url: string | null;
    artwork_url: string | null;
    position: number;
  }>;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

const STORE_FILE = process.env.USER_PLAYLIST_STORE_FILE
  ? process.env.USER_PLAYLIST_STORE_FILE
  : join(process.cwd(), 'data', 'user_playlists_store.json');

let writeQueue: Promise<void> = Promise.resolve();

function emptyStore(): StoreShape {
  return { playlists: [], favorite_artists: [] };
}

function ensureStoreDir(): void {
  const dir = dirname(STORE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getOwnerKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isLikedTracksPlaylist(name: string | null | undefined): boolean {
  return (name ?? '').trim().toLowerCase() === 'liked tracks';
}

function normalizeTrackPosition(index: number, value: number): number {
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return index + 1;
}

function normalizeGenreMeta(input?: PlaylistGenreMeta | null): PlaylistGenreMeta {
  const genreGroup = (input?.genre_group ?? '').trim().slice(0, 80);
  const subgenre = (input?.subgenre ?? '').trim().slice(0, 120);
  const relatedParent = (input?.related_parent_playlist_id ?? '').trim();
  const coverRaw = (input?.cover_url ?? '').trim();
  const cover_url = /^https?:\/\//i.test(coverRaw) ? coverRaw.slice(0, 1200) : null;
  return {
    genre_group: genreGroup || null,
    subgenre: subgenre || null,
    related_parent_playlist_id: relatedParent || null,
    cover_url,
  };
}

function getTrackMergeKey(track: Pick<StoreTrack, 'title' | 'artist' | 'album' | 'spotify_url'>): string {
  const spotifyUrl = (track.spotify_url ?? '').trim().toLowerCase();
  if (spotifyUrl) return `spotify:${spotifyUrl}`;
  const artist = (track.artist ?? '').trim().toLowerCase();
  const title = (track.title ?? '').trim().toLowerCase();
  const album = (track.album ?? '').trim().toLowerCase();
  return `meta:${artist}::${title}::${album}`;
}

function mergeTracks(target: StoreTrack[], source: StoreTrack[]): StoreTrack[] {
  const merged = [...target];
  const seen = new Set(merged.map((track) => getTrackMergeKey(track)));
  for (const track of source) {
    const key = getTrackMergeKey(track);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      ...track,
      id: randomUUID(),
      position: merged.length + 1,
    });
  }
  return merged.map((track, index) => ({
    ...track,
    position: index + 1,
  }));
}

function normalizeStoredPlaylist(raw: StorePlaylist): StorePlaylist {
  const meta = normalizeGenreMeta({
    genre_group: (raw as Partial<StorePlaylist>).genre_group ?? null,
    subgenre: (raw as Partial<StorePlaylist>).subgenre ?? null,
    related_parent_playlist_id: (raw as Partial<StorePlaylist>).related_parent_playlist_id ?? null,
    cover_url: (raw as Partial<StorePlaylist>).cover_url ?? null,
  });
  return {
    ...raw,
    genre_group: meta.genre_group,
    subgenre: meta.subgenre,
    related_parent_playlist_id: meta.related_parent_playlist_id,
    cover_url: meta.cover_url ?? null,
    shared_with: Array.isArray((raw as Partial<StorePlaylist>).shared_with)
      ? ((raw as Partial<StorePlaylist>).shared_with as string[])
          .map((entry) => getOwnerKey(entry))
          .filter(Boolean)
      : [],
    is_public: Boolean((raw as Partial<StorePlaylist>).is_public),
    is_public_fallback: Boolean((raw as Partial<StorePlaylist>).is_public_fallback),
    tracks: Array.isArray((raw as Partial<StorePlaylist>).tracks)
      ? ((raw as Partial<StorePlaylist>).tracks as StoreTrack[]).map((track, index) => ({
          id: track.id,
          title: track.title,
          artist: track.artist ?? null,
          album: track.album ?? null,
          spotify_url: track.spotify_url ?? null,
          artwork_url: (track as Partial<StoreTrack>).artwork_url ?? null,
          position: normalizeTrackPosition(index, track.position),
        }))
      : [],
  };
}

function readStore(): StoreShape {
  ensureStoreDir();
  if (!fs.existsSync(STORE_FILE)) return emptyStore();
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    if (!raw.trim()) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    const playlists = Array.isArray(parsed.playlists)
      ? parsed.playlists.map((entry) => normalizeStoredPlaylist(entry as StorePlaylist))
      : [];
    const favorite_artists = Array.isArray(parsed.favorite_artists)
      ? parsed.favorite_artists
      : [];
    return { playlists, favorite_artists };
  } catch (err) {
    console.warn('[user-playlists] Store read failed, using empty store:', (err as Error).message);
    return emptyStore();
  }
}

async function writeStore(store: StoreShape): Promise<void> {
  ensureStoreDir();
  const data = JSON.stringify(store, null, 2);
  const tmpFile = `${STORE_FILE}.tmp`;

  try {
    await fs.promises.writeFile(tmpFile, data, 'utf8');
    let attempts = 0;
    while (attempts < 10) {
      try {
        if (fs.existsSync(STORE_FILE)) {
          try {
            await fs.promises.unlink(STORE_FILE);
          } catch {
            // Best-effort for Windows rename behavior.
          }
        }
        await fs.promises.rename(tmpFile, STORE_FILE);
        return;
      } catch (err) {
        attempts += 1;
        if (attempts >= 10) throw err;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  } catch (err) {
    console.warn('[user-playlists] Atomic write failed, falling back to direct write:', (err as Error).message);
    await fs.promises.writeFile(STORE_FILE, data, 'utf8');
  }
}

function matchesOwner(playlist: StorePlaylist, owner: PlaylistOwner): boolean {
  return getOwnerKey(playlist.nickname) === getOwnerKey(owner.nickname);
}

function canViewPlaylist(playlist: StorePlaylist, viewer: PlaylistOwner): boolean {
  if (matchesOwner(playlist, viewer)) return true;
  const viewerKey = getOwnerKey(viewer.nickname);
  return !!viewerKey && playlist.shared_with.includes(viewerKey);
}

function mapPlaylistSummary(playlist: StorePlaylist, viewer: PlaylistOwner): PlaylistSummary {
  const viewerKey = getOwnerKey(viewer.nickname);
  const ownerKey = getOwnerKey(playlist.nickname);
  const isOwner = !!viewerKey && viewerKey === ownerKey;
  const sharedWithViewer = !isOwner && playlist.shared_with.includes(viewerKey);
  return {
    id: playlist.id,
    name: playlist.name,
    source: playlist.source,
    created_at: playlist.created_at,
    track_count: playlist.tracks.length,
    genre_group: playlist.genre_group ?? null,
    subgenre: playlist.subgenre ?? null,
    related_parent_playlist_id: playlist.related_parent_playlist_id ?? null,
    cover_url: playlist.cover_url ?? null,
    owner_username: playlist.nickname,
    shared_with: [...playlist.shared_with],
    shared_with_count: playlist.shared_with.length,
    shared_with_viewer: sharedWithViewer,
    is_owner: isOwner,
    viewer_can_edit: isOwner,
    is_public: playlist.is_public,
    is_public_fallback: playlist.is_public_fallback,
  };
}

function migrateOwnerPlaylists(store: StoreShape, owner: PlaylistOwner): void {
  const ownerKey = getOwnerKey(owner.nickname);
  if (!ownerKey) return;

  const ownerPlaylists = store.playlists.filter((playlist) => getOwnerKey(playlist.nickname) === ownerKey);
  for (const playlist of ownerPlaylists) {
    playlist.nickname = owner.nickname;
    playlist.device_id = owner.deviceId;
  }

  const likedPlaylists = ownerPlaylists
    .filter((playlist) => isLikedTracksPlaylist(playlist.name))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  if (likedPlaylists.length <= 1) return;

  const canonical = likedPlaylists[0];
  for (let i = 1; i < likedPlaylists.length; i += 1) {
    const duplicate = likedPlaylists[i];
    canonical.tracks = mergeTracks(canonical.tracks, duplicate.tracks);
    canonical.shared_with = Array.from(new Set([...canonical.shared_with, ...duplicate.shared_with]));
    canonical.is_public = canonical.is_public || duplicate.is_public;
    canonical.is_public_fallback = canonical.is_public_fallback || duplicate.is_public_fallback;
    const duplicateIndex = store.playlists.findIndex((entry) => entry.id === duplicate.id);
    if (duplicateIndex >= 0) store.playlists.splice(duplicateIndex, 1);
  }
}

function ensureLikedTracksPlaylist(store: StoreShape, owner: PlaylistOwner): void {
  const liked = store.playlists.find((entry) => isLikedTracksPlaylist(entry.name) && matchesOwner(entry, owner));
  if (liked) return;

  const playlistId = randomUUID();
  const createdAt = new Date().toISOString();
  store.playlists.push({
    id: playlistId,
    nickname: owner.nickname,
    device_id: owner.deviceId,
    name: 'Liked Tracks',
    source: 'manual',
    created_at: createdAt,
    genre_group: 'Other',
    subgenre: 'Liked',
    related_parent_playlist_id: null,
    cover_url: null,
    shared_with: [],
    is_public: false,
    is_public_fallback: false,
    tracks: [],
  });
}

async function withStoreAccess<T>(operation: (store: StoreShape) => T | Promise<T>, write = false): Promise<T> {
  const run = writeQueue.then(async () => {
    const store = readStore();
    const result = await operation(store);
    if (write) {
      await writeStore(store);
    }
    return result;
  });
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function getUserPlaylistUsage(owner: PlaylistOwner): Promise<PlaylistUsage> {
  return withStoreAccess((store) => {
    migrateOwnerPlaylists(store, owner);
    const ownerPlaylists = store.playlists.filter((playlist) => matchesOwner(playlist, owner));
    const tracks = ownerPlaylists.reduce((sum, playlist) => sum + playlist.tracks.length, 0);
    return {
      playlists: ownerPlaylists.length,
      tracks,
    };
  }, true);
}

export async function createUserPlaylist(
  owner: PlaylistOwner,
  name: string,
  tracks: CreatePlaylistInputTrack[],
  source = 'exportify',
  genreMeta?: PlaylistGenreMeta,
): Promise<{ id: string; name: string; trackCount: number }> {
  return withStoreAccess((store) => {
    migrateOwnerPlaylists(store, owner);
    const playlistId = randomUUID();
    const createdAt = new Date().toISOString();
    const normalizedTracks: StoreTrack[] = tracks.map((track, index) => ({
      id: randomUUID(),
      title: track.title,
      artist: track.artist,
      album: track.album,
      spotify_url: track.spotify_url,
      artwork_url: track.artwork_url ?? null,
      position: normalizeTrackPosition(index, track.position),
    }));

    const meta = normalizeGenreMeta(genreMeta);
    store.playlists.push({
      id: playlistId,
      nickname: owner.nickname,
      device_id: owner.deviceId,
      name,
      source,
      created_at: createdAt,
      genre_group: meta.genre_group,
      subgenre: meta.subgenre,
      related_parent_playlist_id: meta.related_parent_playlist_id,
      cover_url: meta.cover_url ?? null,
      shared_with: [],
      is_public: false,
      is_public_fallback: false,
      tracks: normalizedTracks,
    });

    return {
      id: playlistId,
      name,
      trackCount: normalizedTracks.length,
    };
  }, true);
}

export async function listUserPlaylists(owner: PlaylistOwner): Promise<PlaylistSummary[]> {
  return withStoreAccess((store) => {
    migrateOwnerPlaylists(store, owner);
    ensureLikedTracksPlaylist(store, owner);
    return store.playlists
      .filter((playlist) => canViewPlaylist(playlist, owner))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((playlist) => mapPlaylistSummary(playlist, owner));
  }, true);
}

export async function getUserPlaylistTracks(
  owner: PlaylistOwner,
  playlistId: string,
): Promise<StoreTrack[] | null> {
  return withStoreAccess((store) => {
    migrateOwnerPlaylists(store, owner);
    const playlist = store.playlists.find((entry) => entry.id === playlistId && canViewPlaylist(entry, owner));
    if (!playlist) return null;
    return [...playlist.tracks].sort((a, b) => a.position - b.position);
  }, true);
}

export async function addTrackToUserPlaylist(
  owner: PlaylistOwner,
  playlistId: string,
  track: CreatePlaylistInputTrack,
): Promise<{ success: boolean; playlistId: string }> {
  return withStoreAccess((store) => {
    migrateOwnerPlaylists(store, owner);
    const playlist = store.playlists.find((entry) => entry.id === playlistId && matchesOwner(entry, owner));
    if (!playlist) return { success: false, playlistId };

    playlist.tracks.push({
      id: randomUUID(),
      title: track.title,
      artist: track.artist,
      album: track.album,
      spotify_url: track.spotify_url,
      artwork_url: track.artwork_url ?? null,
      position: track.position ?? (playlist.tracks.length + 1),
    });
    playlist.tracks = playlist.tracks
      .sort((a, b) => a.position - b.position)
      .map((entry, index) => ({ ...entry, position: index + 1 }));
    return { success: true, playlistId };
  }, true);
}

export async function appendTracksToUserPlaylist(
  owner: PlaylistOwner,
  playlistId: string,
  tracks: CreatePlaylistInputTrack[],
): Promise<{ success: boolean; playlistId: string; added: number; total: number }> {
  return withStoreAccess((store) => {
    migrateOwnerPlaylists(store, owner);
    const playlist = store.playlists.find((entry) => entry.id === playlistId && matchesOwner(entry, owner));
    if (!playlist) return { success: false, playlistId, added: 0, total: 0 };
    const seen = new Set(playlist.tracks.map((track) => getTrackMergeKey(track)));
    let added = 0;
    for (const track of tracks) {
      const candidate: StoreTrack = {
        id: randomUUID(),
        title: String(track.title ?? '').trim(),
        artist: track.artist ?? null,
        album: track.album ?? null,
        spotify_url: track.spotify_url ?? null,
        artwork_url: track.artwork_url ?? null,
        position: playlist.tracks.length + 1,
      };
      if (!candidate.title) continue;
      const key = getTrackMergeKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      playlist.tracks.push(candidate);
      added += 1;
    }
    playlist.tracks = playlist.tracks
      .sort((a, b) => a.position - b.position)
      .map((entry, index) => ({ ...entry, position: index + 1 }));
    return { success: true, playlistId, added, total: playlist.tracks.length };
  }, true);
}

export async function removeTrackFromUserPlaylist(
  owner: PlaylistOwner,
  playlistId: string,
  trackId: string,
): Promise<boolean> {
  return withStoreAccess((store) => {
    migrateOwnerPlaylists(store, owner);
    const playlist = store.playlists.find((entry) => entry.id === playlistId && matchesOwner(entry, owner));
    if (!playlist) return false;
    const index = playlist.tracks.findIndex((track) => track.id === trackId);
    if (index < 0) return false;
    playlist.tracks.splice(index, 1);
    playlist.tracks = playlist.tracks
      .sort((a, b) => a.position - b.position)
      .map((entry, order) => ({ ...entry, position: order + 1 }));
    return true;
  }, true);
}

export async function updateTrackInUserPlaylist(
  owner: PlaylistOwner,
  playlistId: string,
  trackId: string,
  updates: { title?: string | null; artist?: string | null },
): Promise<{ id: string; title: string; artist: string | null; album: string | null; spotify_url: string | null; artwork_url: string | null; position: number } | null> {
  return withStoreAccess((store) => {
    migrateOwnerPlaylists(store, owner);
    const playlist = store.playlists.find((entry) => entry.id === playlistId && matchesOwner(entry, owner));
    if (!playlist) return null;
    const track = playlist.tracks.find((entry) => entry.id === trackId);
    if (!track) return null;

    const nextTitle = typeof updates.title === 'string' ? updates.title.trim().slice(0, 300) : track.title;
    const nextArtistRaw = typeof updates.artist === 'string' ? updates.artist.trim().slice(0, 300) : (track.artist ?? '');
    const nextArtist = nextArtistRaw || null;
    if (!nextTitle) return null;

    track.title = nextTitle;
    track.artist = nextArtist;
    return {
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      spotify_url: track.spotify_url,
      artwork_url: track.artwork_url,
      position: track.position,
    };
  }, true);
}

export async function backfillUserPlaylistTrackArtwork(
  owner: PlaylistOwner,
  playlistId: string,
  updates: Array<{ trackId: string; artwork_url: string | null }>,
): Promise<{ updated: number; skipped: number; missing: number } | null> {
  return withStoreAccess((store) => {
    migrateOwnerPlaylists(store, owner);
    const playlist = store.playlists.find((entry) => entry.id === playlistId && matchesOwner(entry, owner));
    if (!playlist) return null;
    let updated = 0;
    let skipped = 0;
    let missing = 0;
    for (const update of updates) {
      const trackId = (update.trackId ?? '').trim();
      if (!trackId) {
        skipped += 1;
        continue;
      }
      const artwork = (update.artwork_url ?? '').trim();
      if (!artwork) {
        skipped += 1;
        continue;
      }
      const track = playlist.tracks.find((entry) => entry.id === trackId);
      if (!track) {
        missing += 1;
        continue;
      }
      if ((track.artwork_url ?? '').trim()) {
        skipped += 1;
        continue;
      }
      track.artwork_url = artwork.slice(0, 1200);
      updated += 1;
    }
    return { updated, skipped, missing };
  }, true);
}

export async function getOrCreateLikedTracksPlaylist(
  owner: PlaylistOwner,
): Promise<{ id: string; name: string }> {
  return withStoreAccess((store) => {
    migrateOwnerPlaylists(store, owner);
    ensureLikedTracksPlaylist(store, owner);
    const playlist = store.playlists.find((entry) => isLikedTracksPlaylist(entry.name) && matchesOwner(entry, owner));
    if (!playlist) return { id: '', name: 'Liked Tracks' };
    return { id: playlist.id, name: playlist.name };
  }, true);
}

export async function getUserPlaylistTracksPage(
  owner: PlaylistOwner,
  playlistId: string,
  limit: number,
  offset: number,
): Promise<PlaylistTrackPage | null> {
  return withStoreAccess((store) => {
    migrateOwnerPlaylists(store, owner);
    const playlist = store.playlists.find((entry) => entry.id === playlistId && canViewPlaylist(entry, owner));
    if (!playlist) return null;
    const sorted = [...playlist.tracks].sort((a, b) => a.position - b.position);
    const safeLimit = Math.max(1, Math.min(limit, 300));
    const safeOffset = Math.max(0, offset);
    const items = sorted.slice(safeOffset, safeOffset + safeLimit);
    return {
      items,
      total: sorted.length,
      limit: safeLimit,
      offset: safeOffset,
      hasMore: safeOffset + items.length < sorted.length,
    };
  }, true);
}

export async function deleteUserPlaylist(
  owner: PlaylistOwner,
  playlistId: string,
): Promise<boolean> {
  return withStoreAccess((store) => {
    migrateOwnerPlaylists(store, owner);
    const index = store.playlists.findIndex((entry) => entry.id === playlistId && matchesOwner(entry, owner));
    if (index < 0) return false;
    if (isLikedTracksPlaylist(store.playlists[index]?.name)) return false;
    store.playlists.splice(index, 1);
    return true;
  }, true);
}

export async function deletePublicUserPlaylistById(
  playlistId: string,
): Promise<boolean> {
  return withStoreAccess((store) => {
    const index = store.playlists.findIndex((entry) => entry.id === playlistId && entry.is_public);
    if (index < 0) return false;
    if (isLikedTracksPlaylist(store.playlists[index]?.name)) return false;
    store.playlists.splice(index, 1);
    return true;
  }, true);
}

export async function updateUserPlaylistSharing(
  owner: PlaylistOwner,
  playlistId: string,
  updates: {
    shareWithUsername?: string | null;
    isPublic?: boolean;
    isPublicFallback?: boolean;
  },
): Promise<PlaylistSummary | null> {
  return withStoreAccess((store) => {
    migrateOwnerPlaylists(store, owner);
    const playlist = store.playlists.find((entry) => entry.id === playlistId && matchesOwner(entry, owner));
    if (!playlist) return null;

    if (typeof updates.shareWithUsername === 'string') {
      const nextUser = getOwnerKey(updates.shareWithUsername);
      if (nextUser && nextUser !== getOwnerKey(owner.nickname) && !playlist.shared_with.includes(nextUser)) {
        playlist.shared_with.push(nextUser);
      }
    }

    if (typeof updates.isPublic === 'boolean') {
      playlist.is_public = updates.isPublic;
    }

    if (typeof updates.isPublicFallback === 'boolean') {
      playlist.is_public_fallback = updates.isPublicFallback;
    }

    return mapPlaylistSummary(playlist, owner);
  }, true);
}

export async function listPublicUserPlaylists(limit = 100, offset = 0): Promise<PlaylistSummary[]> {
  return withStoreAccess((store) => {
    const safeLimit = Math.max(1, Math.min(limit, 250));
    const safeOffset = Math.max(0, offset);
    return store.playlists
      .filter((playlist) => playlist.is_public || playlist.is_public_fallback)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(safeOffset, safeOffset + safeLimit)
      .map((playlist) => ({
        id: `user:${playlist.id}`,
        name: playlist.name,
        source: playlist.source,
        created_at: playlist.created_at,
        track_count: playlist.tracks.length,
        genre_group: playlist.genre_group ?? null,
        subgenre: playlist.subgenre ?? null,
        related_parent_playlist_id: playlist.related_parent_playlist_id ?? null,
        cover_url: playlist.cover_url ?? null,
        owner_username: playlist.nickname,
        shared_with: [...playlist.shared_with],
        shared_with_count: playlist.shared_with.length,
        shared_with_viewer: false,
        is_owner: false,
        viewer_can_edit: false,
        is_public: true,
        is_public_fallback: playlist.is_public_fallback,
      }));
  });
}

export async function getPublicUserPlaylistTracks(prefixedPlaylistId: string): Promise<StoreTrack[] | null> {
  return withStoreAccess((store) => {
    const playlistId = prefixedPlaylistId.startsWith('user:') ? prefixedPlaylistId.slice(5) : prefixedPlaylistId;
    const playlist = store.playlists.find((entry) => entry.id === playlistId && entry.is_public);
    if (!playlist) return null;
    return [...playlist.tracks].sort((a, b) => a.position - b.position);
  });
}

export async function getUserPlaylistTracksForFallback(prefixedPlaylistId: string): Promise<{
  id: string;
  name: string;
  owner_username: string;
  tracks: StoreTrack[];
} | null> {
  return withStoreAccess((store) => {
    const playlistId = prefixedPlaylistId.startsWith('user:') ? prefixedPlaylistId.slice(5) : prefixedPlaylistId;
    const playlist = store.playlists.find((entry) => entry.id === playlistId);
    if (!playlist) return null;
    return {
      id: `user:${playlist.id}`,
      name: playlist.name,
      owner_username: playlist.nickname,
      tracks: [...playlist.tracks].sort((a, b) => a.position - b.position),
    };
  });
}

export async function hasPublicFallbackUserPlaylist(prefixedPlaylistId: string): Promise<boolean> {
  return withStoreAccess((store) => {
    const playlistId = prefixedPlaylistId.startsWith('user:') ? prefixedPlaylistId.slice(5) : prefixedPlaylistId;
    return store.playlists.some((entry) => entry.id === playlistId && entry.is_public_fallback);
  });
}

export async function getAnyUserPlaylistMetaByName(name: string): Promise<{
  id: string;
  name: string;
  genre_group: string | null;
  subgenre: string | null;
} | null> {
  return withStoreAccess((store) => {
    const needle = name.trim().toLowerCase();
    if (!needle) return null;
    const match = store.playlists.find((playlist) => playlist.name.trim().toLowerCase() === needle);
    if (!match) return null;
    return {
      id: match.id,
      name: match.name,
      genre_group: match.genre_group ?? null,
      subgenre: match.subgenre ?? null,
    };
  });
}

export async function listFavoriteArtists(owner: PlaylistOwner): Promise<FavoriteArtist[]> {
  return withStoreAccess((store) => {
    return store.favorite_artists
      .filter((artist) => artist.id === getOwnerKey(owner.nickname))
      .sort((a, b) => b.added_at.localeCompare(a.added_at));
  });
}

export async function addFavoriteArtist(
  owner: PlaylistOwner,
  artist: { mbid: string; name: string; image_url: string | null; country: string | null },
): Promise<FavoriteArtist> {
  return withStoreAccess((store) => {
    const ownerKey = getOwnerKey(owner.nickname);
    const existing = store.favorite_artists.find(
      (a) => a.id === ownerKey && a.mbid === artist.mbid,
    );
    if (existing) return existing;

    const newArtist: FavoriteArtist = {
      id: ownerKey,
      mbid: artist.mbid,
      name: artist.name,
      image_url: artist.image_url,
      country: artist.country,
      added_at: new Date().toISOString(),
    };
    store.favorite_artists.push(newArtist);
    return newArtist;
  }, true);
}

export async function removeFavoriteArtist(owner: PlaylistOwner, mbid: string): Promise<boolean> {
  return withStoreAccess((store) => {
    const ownerKey = getOwnerKey(owner.nickname);
    const index = store.favorite_artists.findIndex(
      (a) => a.id === ownerKey && a.mbid === mbid,
    );
    if (index < 0) return false;
    store.favorite_artists.splice(index, 1);
    return true;
  }, true);
}

export async function updateFavoriteArtistMetadata(
  owner: PlaylistOwner,
  mbid: string,
  updates: { image_url?: string | null; country?: string | null },
): Promise<FavoriteArtist | null> {
  return withStoreAccess((store) => {
    const ownerKey = getOwnerKey(owner.nickname);
    const target = store.favorite_artists.find((a) => a.id === ownerKey && a.mbid === mbid);
    if (!target) return null;
    if (Object.prototype.hasOwnProperty.call(updates, 'image_url')) {
      target.image_url = updates.image_url ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'country')) {
      target.country = updates.country ?? null;
    }
    return target;
  }, true);
}

export async function followPublicPlaylist(
  owner: PlaylistOwner,
  prefixedPlaylistId: string,
): Promise<PlaylistSummary | null> {
  return withStoreAccess((store) => {
    migrateOwnerPlaylists(store, owner);
    const playlistId = prefixedPlaylistId.startsWith('user:') ? prefixedPlaylistId.slice(5) : prefixedPlaylistId;
    const playlist = store.playlists.find((entry) => entry.id === playlistId && entry.is_public);
    if (!playlist) return null;
    if (matchesOwner(playlist, owner)) return mapPlaylistSummary(playlist, owner);
    const viewerKey = getOwnerKey(owner.nickname);
    if (!viewerKey) return null;
    if (!playlist.shared_with.includes(viewerKey)) {
      playlist.shared_with.push(viewerKey);
    }
    return mapPlaylistSummary(playlist, owner);
  }, true);
}

export async function isFavoriteArtist(owner: PlaylistOwner, mbid: string): Promise<boolean> {
  return withStoreAccess((store) => {
    const ownerKey = getOwnerKey(owner.nickname);
    return store.favorite_artists.some(
      (a) => a.id === ownerKey && a.mbid === mbid,
    );
  });
}
