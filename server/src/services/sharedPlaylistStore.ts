import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SharedTrackInput {
  title: string;
  artist: string | null;
  album: string | null;
  spotify_url: string | null;
  position: number;
}

export interface PlaylistGenreMeta {
  genre_group: string | null;
  subgenre: string | null;
  related_parent_playlist_id: string | null;
  cover_url?: string | null;
}

interface SharedTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  spotify_url: string | null;
  position: number;
}

interface SharedPlaylist {
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
  tracks: SharedTrack[];
}

interface SharedStoreShape {
  playlists: SharedPlaylist[];
}

const SHARED_FALLBACK_PREFIX = 'shared:';
export type SharedFallbackPlayMode = 'random' | 'ordered';

export interface SharedPlaylistSummary {
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
}

export interface SharedPlaylistTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  spotify_url: string | null;
  position: number;
}

export interface SharedPlaylistTrackPage {
  items: SharedPlaylistTrack[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SharedIngestOptions {
  name: string;
  source?: string;
  createdAt?: string;
  addedBy?: string | null;
  genreMeta?: PlaylistGenreMeta;
}

export interface SharedIngestResult {
  imported: boolean;
  playlistId: string | null;
  name: string;
  trackCount: number;
  reason?: string;
}

export interface SharedStoreLimits {
  maxSharedPlaylists: number;
  maxSharedTracks: number;
  maxTracksPerSharedPlaylist: number;
}

const STORE_FILE = process.env.SHARED_PLAYLIST_STORE_FILE
  ? process.env.SHARED_PLAYLIST_STORE_FILE
  : join(process.cwd(), 'data', 'shared_playlists_store.json');

let writeQueue: Promise<void> = Promise.resolve();

export function toSharedFallbackPlaylistId(
  playlistId: string,
  mode: SharedFallbackPlayMode = 'random',
): string {
  const id = playlistId.trim();
  if (!id) return `${SHARED_FALLBACK_PREFIX}`;
  if (mode === 'ordered') return `${SHARED_FALLBACK_PREFIX}${id}:ordered`;
  return `${SHARED_FALLBACK_PREFIX}${id}`;
}

export function parseSharedFallbackPlaylistId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith(SHARED_FALLBACK_PREFIX)) return null;
  const raw = trimmed.slice(SHARED_FALLBACK_PREFIX.length).trim();
  if (!raw) return null;
  const [id] = raw.split(':');
  const normalized = (id ?? '').trim();
  return normalized || null;
}

export function parseSharedFallbackPlayMode(value: string | null | undefined): SharedFallbackPlayMode {
  if (!value) return 'random';
  const trimmed = value.trim();
  if (!trimmed.startsWith(SHARED_FALLBACK_PREFIX)) return 'random';
  const raw = trimmed.slice(SHARED_FALLBACK_PREFIX.length).trim().toLowerCase();
  if (raw.endsWith(':ordered')) return 'ordered';
  return 'random';
}

function emptyStore(): SharedStoreShape {
  return { playlists: [] };
}

function ensureStoreDir(): void {
  const dir = dirname(STORE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readStore(): SharedStoreShape {
  ensureStoreDir();
  if (!fs.existsSync(STORE_FILE)) return emptyStore();
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    if (!raw.trim()) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<SharedStoreShape>;
    const playlists = Array.isArray(parsed.playlists)
      ? parsed.playlists.map((entry) => normalizeStoredPlaylist(entry as SharedPlaylist))
      : [];
    return { playlists };
  } catch (err) {
    console.warn('[shared-playlists] Store read failed, using empty store:', (err as Error).message);
    return emptyStore();
  }
}

function writeStore(store: SharedStoreShape): void {
  ensureStoreDir();
  const tmpFile = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmpFile, STORE_FILE);
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function normalizeStoredPlaylist(raw: SharedPlaylist): SharedPlaylist {
  const meta = normalizeGenreMeta({
    genre_group: (raw as Partial<SharedPlaylist>).genre_group ?? null,
    subgenre: (raw as Partial<SharedPlaylist>).subgenre ?? null,
    related_parent_playlist_id: (raw as Partial<SharedPlaylist>).related_parent_playlist_id ?? null,
    cover_url: (raw as Partial<SharedPlaylist>).cover_url ?? null,
  });
  return {
    ...raw,
    genre_group: meta.genre_group,
    subgenre: meta.subgenre,
    related_parent_playlist_id: meta.related_parent_playlist_id,
    cover_url: meta.cover_url ?? null,
  };
}

function makeTrackKey(artist: string | null, title: string): string {
  return `${normalizeText(artist ?? '')}|${normalizeText(title)}`;
}

function totalTrackCount(playlists: SharedPlaylist[]): number {
  return playlists.reduce((sum, playlist) => sum + playlist.tracks.length, 0);
}

function normalizePosition(index: number, position: number): number {
  if (Number.isFinite(position) && position > 0) return Math.floor(position);
  return index + 1;
}

async function withWriteLock<T>(operation: (store: SharedStoreShape) => T): Promise<T> {
  const run = writeQueue.then(() => {
    const store = readStore();
    const result = operation(store);
    writeStore(store);
    return result;
  });
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

function enforceLimits(store: SharedStoreShape, limits: SharedStoreLimits): void {
  const normalizedPlaylists = Math.max(1, limits.maxSharedPlaylists);
  const normalizedTracks = Math.max(1, limits.maxSharedTracks);

  // Remove oldest playlists first when caps are exceeded.
  store.playlists.sort((a, b) => a.imported_at.localeCompare(b.imported_at));
  while (store.playlists.length > normalizedPlaylists) {
    store.playlists.shift();
  }
  while (totalTrackCount(store.playlists) > normalizedTracks && store.playlists.length > 0) {
    store.playlists.shift();
  }
}

export async function ingestSharedPlaylist(
  tracks: SharedTrackInput[],
  options: SharedIngestOptions,
  limits: SharedStoreLimits,
): Promise<SharedIngestResult> {
  return withWriteLock((store) => {
    const maxTracksPerPlaylist = Math.max(1, limits.maxTracksPerSharedPlaylist);
    const uniqueInPlaylist = new Set<string>();
    const normalizedTracks: SharedTrack[] = [];

    for (const [index, input] of tracks.entries()) {
      const title = input.title.trim();
      const artist = input.artist?.trim() || null;
      if (!title) continue;

      const key = makeTrackKey(artist, title);
      if (uniqueInPlaylist.has(key)) continue;
      uniqueInPlaylist.add(key);

      normalizedTracks.push({
        id: randomUUID(),
        title,
        artist,
        album: input.album?.trim() || null,
        spotify_url: input.spotify_url?.trim() || null,
        position: normalizePosition(index, input.position),
      });

      if (normalizedTracks.length >= maxTracksPerPlaylist) break;
    }

    if (normalizedTracks.length === 0) {
      return {
        imported: false,
        playlistId: null,
        name: options.name,
        trackCount: 0,
        reason: 'Geen unieke tracks over na dedupe',
      };
    }

    const createdAt = options.createdAt ?? new Date().toISOString();
    const importedAt = new Date().toISOString();
    const playlistId = randomUUID();
    const safeName = options.name.trim().slice(0, 140) || 'Shared playlist';
    const meta = normalizeGenreMeta(options.genreMeta);

    store.playlists.push({
      id: playlistId,
      name: safeName,
      source: options.source?.trim() || 'exportify-shared',
      created_at: createdAt,
      imported_at: importedAt,
      track_count: normalizedTracks.length,
      added_by: options.addedBy?.trim() || null,
      genre_group: meta.genre_group,
      subgenre: meta.subgenre,
      related_parent_playlist_id: meta.related_parent_playlist_id,
      cover_url: meta.cover_url ?? null,
      tracks: normalizedTracks,
    });

    enforceLimits(store, limits);

    const stillExists = store.playlists.some((playlist) => playlist.id === playlistId);
    if (!stillExists) {
      return {
        imported: false,
        playlistId: null,
        name: safeName,
        trackCount: 0,
        reason: 'Playlist verwijderd door storage limieten',
      };
    }

    return {
      imported: true,
      playlistId,
      name: safeName,
      trackCount: normalizedTracks.length,
    };
  });
}

export async function listSharedPlaylists(limit = 100, offset = 0): Promise<SharedPlaylistSummary[]> {
  const safeLimit = Math.max(1, Math.min(limit, 250));
  const safeOffset = Math.max(0, offset);
  const store = readStore();
  return store.playlists
    .slice()
    .sort((a, b) => b.imported_at.localeCompare(a.imported_at))
    .slice(safeOffset, safeOffset + safeLimit)
    .map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      source: playlist.source,
      created_at: playlist.created_at,
      imported_at: playlist.imported_at,
      track_count: playlist.track_count,
      added_by: playlist.added_by,
      genre_group: playlist.genre_group ?? null,
      subgenre: playlist.subgenre ?? null,
      related_parent_playlist_id: playlist.related_parent_playlist_id ?? null,
      cover_url: playlist.cover_url ?? null,
    }));
}

export async function getSharedPlaylistTracks(playlistId: string): Promise<SharedPlaylistTrack[] | null> {
  const store = readStore();
  const playlist = store.playlists.find((entry) => entry.id === playlistId);
  if (!playlist) return null;
  return playlist.tracks
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((track) => ({
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      spotify_url: track.spotify_url,
      position: track.position,
    }));
}

export async function getSharedPlaylistTracksPage(
  playlistId: string,
  limit: number,
  offset: number,
): Promise<SharedPlaylistTrackPage | null> {
  const store = readStore();
  const playlist = store.playlists.find((entry) => entry.id === playlistId);
  if (!playlist) return null;
  const sorted = playlist.tracks.slice().sort((a, b) => a.position - b.position);
  const safeLimit = Math.max(1, Math.min(limit, 300));
  const safeOffset = Math.max(0, offset);
  const pageItems = sorted.slice(safeOffset, safeOffset + safeLimit).map((track) => ({
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    spotify_url: track.spotify_url,
    position: track.position,
  }));
  return {
    items: pageItems,
    total: sorted.length,
    limit: safeLimit,
    offset: safeOffset,
    hasMore: safeOffset + pageItems.length < sorted.length,
  };
}

export async function hasSharedPlaylist(playlistId: string): Promise<boolean> {
  const store = readStore();
  return store.playlists.some((entry) => entry.id === playlistId);
}

export async function updateSharedPlaylistName(
  playlistId: string,
  name: string,
): Promise<SharedPlaylistSummary | null> {
  const trimmedName = name.trim().slice(0, 140);
  if (!trimmedName) return null;
  return withWriteLock((store) => {
    const playlist = store.playlists.find((entry) => entry.id === playlistId);
    if (!playlist) return null;
    playlist.name = trimmedName;
    return {
      id: playlist.id,
      name: playlist.name,
      source: playlist.source,
      created_at: playlist.created_at,
      imported_at: playlist.imported_at,
      track_count: playlist.track_count,
      added_by: playlist.added_by,
      genre_group: playlist.genre_group ?? null,
      subgenre: playlist.subgenre ?? null,
      related_parent_playlist_id: playlist.related_parent_playlist_id ?? null,
      cover_url: playlist.cover_url ?? null,
    };
  });
}

export async function updateSharedPlaylistGenreMeta(
  playlistId: string,
  genreMeta: PlaylistGenreMeta,
): Promise<SharedPlaylistSummary | null> {
  const nextMeta = normalizeGenreMeta(genreMeta);
  return withWriteLock((store) => {
    const playlist = store.playlists.find((entry) => entry.id === playlistId);
    if (!playlist) return null;
    playlist.genre_group = nextMeta.genre_group;
    playlist.subgenre = nextMeta.subgenre;
    playlist.related_parent_playlist_id = nextMeta.related_parent_playlist_id;
    if (Object.prototype.hasOwnProperty.call(nextMeta, 'cover_url')) {
      playlist.cover_url = nextMeta.cover_url ?? null;
    }
    return {
      id: playlist.id,
      name: playlist.name,
      source: playlist.source,
      created_at: playlist.created_at,
      imported_at: playlist.imported_at,
      track_count: playlist.track_count,
      added_by: playlist.added_by,
      genre_group: playlist.genre_group ?? null,
      subgenre: playlist.subgenre ?? null,
      related_parent_playlist_id: playlist.related_parent_playlist_id ?? null,
      cover_url: playlist.cover_url ?? null,
    };
  });
}

export async function deleteSharedPlaylist(playlistId: string): Promise<boolean> {
  return withWriteLock((store) => {
    const index = store.playlists.findIndex((entry) => entry.id === playlistId);
    if (index < 0) return false;
    store.playlists.splice(index, 1);
    return true;
  });
}

export async function appendTracksToSharedPlaylist(
  playlistId: string,
  tracks: SharedTrackInput[],
  limits: SharedStoreLimits,
): Promise<SharedPlaylistSummary | null> {
  return withWriteLock((store) => {
    const playlist = store.playlists.find((entry) => entry.id === playlistId);
    if (!playlist) return null;
    const maxTracksPerPlaylist = Math.max(1, limits.maxTracksPerSharedPlaylist);
    const existingKeys = new Set<string>(
      playlist.tracks.map((track) => makeTrackKey(track.artist, track.title)),
    );
    let nextPosition = playlist.tracks.reduce((max, track) => Math.max(max, track.position), 0) + 1;
    for (const input of tracks) {
      if (playlist.tracks.length >= maxTracksPerPlaylist) break;
      const title = input.title.trim();
      const artist = input.artist?.trim() || null;
      if (!title) continue;
      const key = makeTrackKey(artist, title);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      playlist.tracks.push({
        id: randomUUID(),
        title,
        artist,
        album: input.album?.trim() || null,
        spotify_url: input.spotify_url?.trim() || null,
        position: nextPosition++,
      });
    }
    playlist.track_count = playlist.tracks.length;
    return {
      id: playlist.id,
      name: playlist.name,
      source: playlist.source,
      created_at: playlist.created_at,
      imported_at: playlist.imported_at,
      track_count: playlist.track_count,
      added_by: playlist.added_by,
      genre_group: playlist.genre_group ?? null,
      subgenre: playlist.subgenre ?? null,
      related_parent_playlist_id: playlist.related_parent_playlist_id ?? null,
      cover_url: playlist.cover_url ?? null,
    };
  });
}

export async function updateSharedPlaylistTrack(
  playlistId: string,
  trackId: string,
  updates: { title?: string | null; artist?: string | null },
): Promise<SharedPlaylistSummary | null> {
  return withWriteLock((store) => {
    const playlist = store.playlists.find((entry) => entry.id === playlistId);
    if (!playlist) return null;
    const track = playlist.tracks.find((entry) => entry.id === trackId);
    if (!track) return null;

    const nextTitle = typeof updates.title === 'string' ? updates.title.trim().slice(0, 300) : track.title;
    const nextArtistRaw = typeof updates.artist === 'string' ? updates.artist.trim().slice(0, 300) : (track.artist ?? '');
    const nextArtist = nextArtistRaw || null;
    if (!nextTitle) return null;

    track.title = nextTitle;
    track.artist = nextArtist;
    playlist.track_count = playlist.tracks.length;
    return {
      id: playlist.id,
      name: playlist.name,
      source: playlist.source,
      created_at: playlist.created_at,
      imported_at: playlist.imported_at,
      track_count: playlist.track_count,
      added_by: playlist.added_by,
      genre_group: playlist.genre_group ?? null,
      subgenre: playlist.subgenre ?? null,
      related_parent_playlist_id: playlist.related_parent_playlist_id ?? null,
      cover_url: playlist.cover_url ?? null,
    };
  });
}

export async function deleteSharedPlaylistTrack(
  playlistId: string,
  trackId: string,
): Promise<SharedPlaylistSummary | null> {
  return withWriteLock((store) => {
    const playlist = store.playlists.find((entry) => entry.id === playlistId);
    if (!playlist) return null;
    const index = playlist.tracks.findIndex((track) => track.id === trackId);
    if (index < 0) return null;
    playlist.tracks.splice(index, 1);
    playlist.tracks = playlist.tracks
      .sort((a, b) => a.position - b.position)
      .map((track, idx) => ({ ...track, position: idx + 1 }));
    playlist.track_count = playlist.tracks.length;
    return {
      id: playlist.id,
      name: playlist.name,
      source: playlist.source,
      created_at: playlist.created_at,
      imported_at: playlist.imported_at,
      track_count: playlist.track_count,
      added_by: playlist.added_by,
      genre_group: playlist.genre_group ?? null,
      subgenre: playlist.subgenre ?? null,
      related_parent_playlist_id: playlist.related_parent_playlist_id ?? null,
      cover_url: playlist.cover_url ?? null,
    };
  });
}

export async function getSharedStoreUsage(): Promise<{ playlists: number; tracks: number }> {
  const store = readStore();
  return {
    playlists: store.playlists.length,
    tracks: totalTrackCount(store.playlists),
  };
}

export async function getSharedPlaylistMetaByName(name: string): Promise<{
  id: string;
  name: string;
  genre_group: string | null;
  subgenre: string | null;
} | null> {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const store = readStore();
  const match = store.playlists.find((playlist) => playlist.name.trim().toLowerCase() === needle);
  if (!match) return null;
  return {
    id: match.id,
    name: match.name,
    genre_group: match.genre_group ?? null,
    subgenre: match.subgenre ?? null,
  };
}

export async function getSharedPlaylistSummaryById(playlistId: string): Promise<SharedPlaylistSummary | null> {
  const id = playlistId.trim();
  if (!id) return null;
  const store = readStore();
  const playlist = store.playlists.find((entry) => entry.id === id);
  if (!playlist) return null;
  return {
    id: playlist.id,
    name: playlist.name,
    source: playlist.source,
    created_at: playlist.created_at,
    imported_at: playlist.imported_at,
    track_count: playlist.track_count,
    added_by: playlist.added_by,
    genre_group: playlist.genre_group ?? null,
    subgenre: playlist.subgenre ?? null,
    related_parent_playlist_id: playlist.related_parent_playlist_id ?? null,
    cover_url: playlist.cover_url ?? null,
  };
}
