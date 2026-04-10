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
const DEFAULT_MAX_TRACKS_PER_PLAYLIST = 3000;

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^"+|"+$/g, '')
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9\u00c0-\u024f]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function decodeCsvText(buffer: Buffer): string {
  if (buffer.length >= 2) {
    const b0 = buffer[0];
    const b1 = buffer[1];
    // UTF-16 LE BOM
    if (b0 === 0xff && b1 === 0xfe) return buffer.slice(2).toString('utf16le');
    // UTF-16 BE BOM
    if (b0 === 0xfe && b1 === 0xff) {
      const swapped = Buffer.allocUnsafe(buffer.length - 2);
      for (let i = 2; i < buffer.length - 1; i += 2) {
        swapped[i - 2] = buffer[i + 1] ?? 0;
        swapped[i - 1] = buffer[i] ?? 0;
      }
      return swapped.toString('utf16le');
    }
  }

  const utf8 = buffer.toString('utf8');
  const sample = utf8.slice(0, 1024);
  const nullCount = (sample.match(/\u0000/g) ?? []).length;
  if (nullCount > 10) {
    // Common Excel export fallback.
    return buffer.toString('utf16le');
  }
  return utf8;
}

function getNormalizedRecord(record: Record<string, unknown>): Map<string, string> {
  const mapped = new Map<string, string>();
  for (const [rawKey, rawValue] of Object.entries(record)) {
    if (typeof rawValue !== 'string') continue;
    const value = rawValue.trim();
    if (!value) continue;
    const key = normalizeHeader(rawKey);
    if (key && !mapped.has(key)) {
      mapped.set(key, value);
    }
  }
  return mapped;
}

function firstValue(normalizedRecord: Map<string, string>, keys: string[]): string {
  const normalizedKeys = keys.map((key) => normalizeHeader(key));

  for (const key of normalizedKeys) {
    const exact = normalizedRecord.get(key);
    if (exact) return exact;
  }

  for (const [header, value] of normalizedRecord.entries()) {
    for (const key of normalizedKeys) {
      if (header.includes(key) || key.includes(header)) {
        return value;
      }
    }
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
  // Exportify saves filenames with spaces replaced by underscores; restore readable titles.
  const withSpaces = raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return withSpaces || 'Imported playlist';
}

function detectCsvDelimiter(text: string): ',' | ';' | '\t' {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
  const comma = (firstLine.match(/,/g) ?? []).length;
  const semicolon = (firstLine.match(/;/g) ?? []).length;
  const tab = (firstLine.match(/\t/g) ?? []).length;
  if (semicolon > comma && semicolon >= tab) return ';';
  if (tab > comma && tab > semicolon) return '\t';
  return ',';
}

function parseCsvBuffer(fileName: string, buffer: Buffer, maxTracks: number): ExportifyPlaylistImport {
  let text = decodeCsvText(buffer)
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n');
  
  // Fix unescaped quotes and apostrophes that break CSV parsing
  // The error "invalid closing quote: found non trimable byte after quote" happens when
  // a quote character appears inside a field but isn't properly escaped with another quote
  // We fix this by doubling any quote that appears to be inside a field
  let result = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (inQuote && text[i + 1] === '"') {
        // Already escaped quote, keep as-is
        result += '""';
        i++; // skip next quote
      } else if (inQuote) {
        // Closing quote
        inQuote = false;
        result += '"';
      } else {
        // Opening quote
        inQuote = true;
        result += '"';
      }
    } else {
      result += char;
    }
  }
  text = result;
  
  const delimiter = detectCsvDelimiter(text);
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
    delimiter,
    escape: '"',
    quote: '"',
  }) as Record<string, unknown>[];

  const dedupe = new Set<string>();
  const tracks: ExportifyTrackRow[] = [];

  const titleKeys = [
    'track name',
    'name',
    'title',
    'song name',
    'track title',
    'nummernaam',
  ];
  const artistKeys = [
    'artist name(s)',
    'artist',
    'artists',
    'artist name',
    'naam van artiest',
    'naam van artiest op het album',
  ];
  const albumKeys = [
    'album name',
    'album',
    'naam van album',
  ];
  const spotifyKeys = [
    'track uri',
    'track url',
    'spotify url',
    'spotify uri',
    'uri',
    'nummer uri',
  ];

  for (const record of records) {
    const normalizedRecord = getNormalizedRecord(record);
    const title = firstValue(normalizedRecord, titleKeys);
    const artist = firstValue(normalizedRecord, artistKeys);
    if (!title || !artist) continue;

    const dedupeKey = `${artist.toLowerCase()}|${title.toLowerCase()}`;
    if (dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);

    const albumRaw = firstValue(normalizedRecord, albumKeys);
    const spotifyRaw = firstValue(normalizedRecord, spotifyKeys);

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
