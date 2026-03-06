import AdmZip from 'adm-zip';
import { basename, extname } from 'node:path';
import { parse } from 'csv-parse/sync';

export interface ExportifyTrackRow {
  title: string;
  artist: string;
  album: string | null;
  spotifyUrl: string | null;
  position: number;
}

export interface ExportifyPlaylistImport {
  name: string;
  tracks: ExportifyTrackRow[];
}

export interface ExportifyParseOptions {
  maxPlaylists?: number;
  maxTracksPerPlaylist?: number;
}

const DEFAULT_MAX_PLAYLISTS = 20;
const DEFAULT_MAX_TRACKS_PER_PLAYLIST = 1500;

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function firstValue(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const found = Object.entries(record).find(([raw]) => normalizeHeader(raw) === key)?.[1];
    if (typeof found === 'string' && found.trim()) return found.trim();
  }
  return '';
}

function normalizeSpotifyUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('https://open.spotify.com/')) return trimmed;
  if (!trimmed.startsWith('spotify:track:')) return null;
  const trackId = trimmed.slice('spotify:track:'.length).trim();
  if (!trackId) return null;
  return `https://open.spotify.com/track/${trackId}`;
}

function normalizePlaylistName(fileName: string): string {
  const raw = basename(fileName, extname(fileName)).trim();
  return raw || 'Imported playlist';
}

function parseCsvBuffer(fileName: string, buffer: Buffer, maxTracks: number): ExportifyPlaylistImport {
  const text = buffer.toString('utf8');
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, unknown>[];

  const dedupe = new Set<string>();
  const tracks: ExportifyTrackRow[] = [];

  for (const record of records) {
    const title = firstValue(record, ['track name', 'name', 'title']);
    const artist = firstValue(record, ['artist name(s)', 'artist', 'artists']);
    if (!title || !artist) continue;

    const dedupeKey = `${artist.toLowerCase()}|${title.toLowerCase()}`;
    if (dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);

    const albumRaw = firstValue(record, ['album name', 'album']);
    const spotifyRaw = firstValue(record, ['track uri', 'track url', 'spotify url', 'uri']);

    tracks.push({
      title,
      artist,
      album: albumRaw || null,
      spotifyUrl: normalizeSpotifyUrl(spotifyRaw),
      position: tracks.length + 1,
    });

    if (tracks.length >= maxTracks) break;
  }

  return {
    name: normalizePlaylistName(fileName),
    tracks,
  };
}

export function parseExportifyUpload(
  fileName: string,
  fileBuffer: Buffer,
  options: ExportifyParseOptions = {},
): ExportifyPlaylistImport[] {
  const maxPlaylists = options.maxPlaylists ?? DEFAULT_MAX_PLAYLISTS;
  const maxTracksPerPlaylist = options.maxTracksPerPlaylist ?? DEFAULT_MAX_TRACKS_PER_PLAYLIST;

  const extension = extname(fileName).toLowerCase();
  if (extension === '.csv') {
    return [parseCsvBuffer(fileName, fileBuffer, maxTracksPerPlaylist)];
  }

  if (extension !== '.zip') {
    throw new Error('Alleen .csv of .zip bestanden zijn toegestaan');
  }

  const zip = new AdmZip(fileBuffer);
  const entries = zip
    .getEntries()
    .filter((entry) => !entry.isDirectory && extname(entry.entryName).toLowerCase() === '.csv')
    .slice(0, maxPlaylists);

  if (entries.length === 0) {
    throw new Error('ZIP bevat geen CSV bestanden');
  }

  const playlists: ExportifyPlaylistImport[] = [];
  for (const entry of entries) {
    const data = entry.getData();
    playlists.push(parseCsvBuffer(entry.entryName, data, maxTracksPerPlaylist));
  }
  return playlists;
}
