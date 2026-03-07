import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface StoreTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  spotify_url: string | null;
  position: number;
}

interface StorePlaylist {
  id: string;
  nickname: string;
  device_id: string;
  name: string;
  source: string;
  created_at: string;
  tracks: StoreTrack[];
}

interface StoreShape {
  playlists: StorePlaylist[];
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
  position: number;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  source: string;
  created_at: string;
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
  return { playlists: [] };
}

function ensureStoreDir(): void {
  const dir = dirname(STORE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readStore(): StoreShape {
  ensureStoreDir();
  if (!fs.existsSync(STORE_FILE)) return emptyStore();
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    if (!raw.trim()) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    const playlists = Array.isArray(parsed.playlists) ? parsed.playlists : [];
    return { playlists };
  } catch (err) {
    console.warn('[user-playlists] Store read failed, using empty store:', (err as Error).message);
    return emptyStore();
  }
}

function writeStore(store: StoreShape): void {
  ensureStoreDir();
  const tmpFile = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmpFile, STORE_FILE);
}

function matchesOwner(playlist: StorePlaylist, owner: PlaylistOwner): boolean {
  return playlist.nickname === owner.nickname && playlist.device_id === owner.deviceId;
}

function normalizeTrackPosition(index: number, value: number): number {
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return index + 1;
}

async function withWriteLock<T>(operation: (store: StoreShape) => T): Promise<T> {
  const run = writeQueue.then(() => {
    const store = readStore();
    const result = operation(store);
    writeStore(store);
    return result;
  });
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function getUserPlaylistUsage(owner: PlaylistOwner): Promise<PlaylistUsage> {
  const store = readStore();
  const ownerPlaylists = store.playlists.filter((playlist) => matchesOwner(playlist, owner));
  const tracks = ownerPlaylists.reduce((sum, playlist) => sum + playlist.tracks.length, 0);
  return {
    playlists: ownerPlaylists.length,
    tracks,
  };
}

export async function createUserPlaylist(
  owner: PlaylistOwner,
  name: string,
  tracks: CreatePlaylistInputTrack[],
  source = 'exportify',
): Promise<{ id: string; name: string; trackCount: number }> {
  return withWriteLock((store) => {
    const playlistId = randomUUID();
    const createdAt = new Date().toISOString();
    const normalizedTracks: StoreTrack[] = tracks.map((track, index) => ({
      id: randomUUID(),
      title: track.title,
      artist: track.artist,
      album: track.album,
      spotify_url: track.spotify_url,
      position: normalizeTrackPosition(index, track.position),
    }));

    store.playlists.push({
      id: playlistId,
      nickname: owner.nickname,
      device_id: owner.deviceId,
      name,
      source,
      created_at: createdAt,
      tracks: normalizedTracks,
    });

    return {
      id: playlistId,
      name,
      trackCount: normalizedTracks.length,
    };
  });
}

export async function listUserPlaylists(owner: PlaylistOwner): Promise<PlaylistSummary[]> {
  const store = readStore();
  return store.playlists
    .filter((playlist) => matchesOwner(playlist, owner))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      source: playlist.source,
      created_at: playlist.created_at,
    }));
}

export async function getUserPlaylistTracks(
  owner: PlaylistOwner,
  playlistId: string,
): Promise<StoreTrack[] | null> {
  const store = readStore();
  const playlist = store.playlists.find((entry) => entry.id === playlistId && matchesOwner(entry, owner));
  if (!playlist) return null;
  return [...playlist.tracks].sort((a, b) => a.position - b.position);
}

export async function getUserPlaylistTracksPage(
  owner: PlaylistOwner,
  playlistId: string,
  limit: number,
  offset: number,
): Promise<PlaylistTrackPage | null> {
  const store = readStore();
  const playlist = store.playlists.find((entry) => entry.id === playlistId && matchesOwner(entry, owner));
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
}

export async function deleteUserPlaylist(
  owner: PlaylistOwner,
  playlistId: string,
): Promise<boolean> {
  return withWriteLock((store) => {
    const index = store.playlists.findIndex((entry) => entry.id === playlistId && matchesOwner(entry, owner));
    if (index < 0) return false;
    store.playlists.splice(index, 1);
    return true;
  });
}
