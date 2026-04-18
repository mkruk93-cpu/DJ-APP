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
  const raw = basename(fileName, extname(fileName))
    .trim()
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036]/g, '"');
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

function getFirstNonEmptyLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
}

function isMp3tagCsv(text: string): boolean {
  const header = getFirstNonEmptyLine(text);
  const normalized = header
    .split(';')
    .map((part) => normalizeHeader(part))
    .filter(Boolean);
  const required = ['title', 'artist', 'album', 'track', 'year', 'length', 'size', 'last modified', 'path', 'filename'];
  return required.every((key, index) => normalized[index] === key);
}

function normalizeCsvCharacters(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036]/g, '"');
}

function sanitizeMalformedCsvQuotes(text: string, delimiter: ',' | ';' | '\t'): string {
  let result = '';
  let inQuotes = false;
  let fieldHasContent = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === delimiter) {
      result += char;
      if (!inQuotes) fieldHasContent = false;
      continue;
    }

    if (char === '\n') {
      result += char;
      if (!inQuotes) fieldHasContent = false;
      continue;
    }

    if (char === '"') {
      const nextIsEscapedQuote = next === '"';
      const nextEndsField = next === delimiter || next === '\n' || typeof next === 'undefined';

      if (nextIsEscapedQuote) {
        result += '""';
        i += 1;
        inQuotes = true;
        fieldHasContent = true;
        continue;
      }

      if (!inQuotes) {
        if (!fieldHasContent) {
          result += '"';
          inQuotes = true;
        } else {
          result += "'";
          fieldHasContent = true;
        }
        continue;
      }

      if (nextEndsField) {
        result += '"';
        inQuotes = false;
      } else {
        // Broken interior quote inside a field: preserve readability instead of failing parse.
        result += "'";
        fieldHasContent = true;
      }
      continue;
    }

    if (!/\s/.test(char)) {
      fieldHasContent = true;
    }
    result += char;
  }

  return result;
}

function parseCsvRecords(text: string, delimiter: ',' | ';' | '\t'): Record<string, unknown>[] {
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_records_with_error: true,
    trim: true,
    delimiter,
    escape: '"',
    quote: '"',
  }) as Record<string, unknown>[];
}

function cleanLooseTagValue(value: string): string {
  return value
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeFileStem(value: string): string {
  return basename(value)
    .replace(/\.[A-Za-z0-9]{1,5}$/u, '')
    .replace(/[\u2010-\u2015\u2212]+/g, '-')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripKnownFilenamePrefixes(value: string): string {
  let out = cleanLooseTagValue(value);
  out = out.replace(/^(?:\(\d{1,4}\)\s*)+/u, '').trim();
  out = out.replace(/^(?:\d{1,4}\s*[-.)]\s*)+/u, '').trim();
  out = out.replace(/^(?:\d{1,4}\s+)/u, '').trim();
  out = out.replace(/^(?:\[[^\]]+\]\s+)+/u, '').trim();
  out = out.replace(/^(?:[^\p{L}\p{N}(]+)\s*/u, '').trim();
  return out;
}

function cleanupArtistOrTitleFromFilename(value: string): string {
  let out = stripKnownFilenamePrefixes(normalizeFileStem(value));
  out = out.replace(/^\(\d{1,4}\)\s*/u, '').trim();
  out = out.replace(/^\[([^\]]+)\]\s*$/u, '$1').trim();
  out = out.replace(/^\[/u, '').replace(/\]$/u, '').trim();
  out = out.replace(/\s*-\s*$/u, '').trim();
  out = out.replace(/^\(([^)]+)\)\s+/u, '($1) ').trim();
  return out;
}

function deriveArtistTitleFromFilename(fileName: string): { artist: string; title: string } | null {
  const cleaned = cleanupArtistOrTitleFromFilename(fileName);
  if (!cleaned || !cleaned.includes(' - ')) return null;
  const [artistRaw, ...rest] = cleaned.split(' - ');
  const artist = cleanLooseTagValue(artistRaw);
  const title = cleanLooseTagValue(rest.join(' - '));
  if (!artist || !title) return null;
  return { artist, title };
}

function deriveArtistFromFilenameUsingTitle(fileName: string, title: string): string | null {
  const stem = normalizeFileStem(fileName);
  const safeTitle = cleanLooseTagValue(title);
  if (!stem || !safeTitle) return null;

  const normalizedStem = stem.toLowerCase();
  const normalizedTitle = safeTitle.toLowerCase();
  const titleIndex = normalizedStem.lastIndexOf(normalizedTitle);
  if (titleIndex < 0) return null;

  let artistPart = stem.slice(0, titleIndex).trim();
  artistPart = artistPart.replace(/\s*-\s*$/u, '').trim();
  artistPart = cleanupArtistOrTitleFromFilename(artistPart);
  if (!artistPart) return null;
  return artistPart;
}

function shouldPreferFilenameArtist(artist: string): boolean {
  const value = cleanLooseTagValue(artist);
  if (!value) return true;
  if (/^[[(][^)\]]*$/u.test(value)) return true;
  if (/^[^\p{L}\p{N}(]*[\p{L}\p{N}].*$/u.test(value) && /^[^\p{L}\p{N}(]/u.test(value)) return true;
  if (/^\d{1,4}$/u.test(value)) return true;
  if (/^(?:track\s*)?\d{1,4}$/iu.test(value)) return true;
  if (/^(?:disc|cd)\s*\d{1,2}$/iu.test(value)) return true;
  if (/^(?:ft|feat|featuring)\.?$/iu.test(value)) return true;
  if (/\b(?:ft|feat|featuring)\.?$/iu.test(value)) return true;
  if ((value.match(/[\[(]/g) ?? []).length > (value.match(/[\])]/g) ?? []).length) return true;
  return false;
}

function cleanImportedTitle(value: string): string {
  let out = cleanLooseTagValue(value);
  out = out.replace(/^[^\[\](){},;:]{0,4}\]\s+/u, '').trim();
  out = out.replace(/^[^\[\](){},;:]{0,4}\)\s+/u, '').trim();
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanImportedArtist(value: string, titleCandidate: string): string | null {
  let out = cleanLooseTagValue(value)
    .replace(/[\u2010-\u2015\u2212]+/g, '-')
    .trim();

  out = out.replace(/^(?:\[[^\]]+\]\s*)+/u, '').trim();
  out = out.replace(/^[^\p{L}\p{N}(]+/u, '').trim();
  out = out.replace(/^\(\d{1,4}\)\s*/u, '').trim();
  out = out.replace(/^\d{2,4}[.)-]?\s+/u, '').trim();

  const safeTitle = cleanLooseTagValue(titleCandidate);
  if (safeTitle) {
    const titleRegex = new RegExp(`\\s*-?\\s*${escapeRegExp(safeTitle)}\\s*$`, 'iu');
    out = out.replace(titleRegex, '').trim();
  }

  out = out.replace(/\s*-\s*$/u, '').trim();
  if (!out) return null;
  if (/^\d{1,4}$/u.test(out)) return null;
  return out;
}

function splitArtistTitleCandidate(value: string): { artist: string; title: string } | null {
  const normalized = cleanLooseTagValue(value).replace(/[\u2010-\u2015\u2212]+/g, ' - ');
  const match = normalized.match(/^(.+?)\s+-\s+(.+)$/u);
  if (!match) return null;
  const artist = cleanLooseTagValue(match[1] ?? '');
  const title = cleanLooseTagValue(match[2] ?? '');
  if (!artist || !title) return null;
  if (/^\d{1,4}$/u.test(artist)) return null;
  if (/\brelease date\b/iu.test(artist) || /\b320\s*kbps\b/iu.test(artist)) return null;
  return { artist, title };
}

function parseMp3tagCsvBuffer(fileName: string, text: string, maxTracks: number): ExportifyPlaylistImport {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\uFEFF/g, '').trim())
    .filter(Boolean);
  if (lines.length <= 1) {
    return { name: normalizePlaylistName(fileName), tracks: [] };
  }

  const dedupe = new Set<string>();
  const tracks: ExportifyTrackRow[] = [];

  for (const rawLine of lines.slice(1)) {
    const parts = rawLine.split(';');
    while (parts.length > 0 && !parts[parts.length - 1]?.trim()) {
      parts.pop();
    }
    if (parts.length < 10) continue;

    const tail = parts.slice(-7);
    const leading = parts.slice(0, -7);
    const filenameValue = cleanLooseTagValue(tail[6] ?? '');
    const derived = filenameValue ? deriveArtistTitleFromFilename(filenameValue) : null;

    const titleCandidateRaw = cleanImportedTitle(leading[0] ?? '');
    const artistCandidateRaw = cleanLooseTagValue(leading[1] ?? '');
    const albumCandidate = cleanLooseTagValue(leading.slice(2).join(';'));
    const splitTitleCandidate = splitArtistTitleCandidate(titleCandidateRaw);
    const titleCandidate = splitTitleCandidate?.title ?? titleCandidateRaw;
    const cleanedArtistCandidate = cleanImportedArtist(artistCandidateRaw, titleCandidate);
    const suspiciousArtistCandidate = shouldPreferFilenameArtist(artistCandidateRaw)
      || (cleanedArtistCandidate !== null && shouldPreferFilenameArtist(cleanedArtistCandidate));

    const filenameArtistFromTitle = filenameValue && titleCandidate
      ? deriveArtistFromFilenameUsingTitle(filenameValue, titleCandidate)
      : null;
    const combinedSplitArtist = splitTitleCandidate?.artist && cleanedArtistCandidate && cleanedArtistCandidate.length <= 6
      ? `${cleanedArtistCandidate}. ${splitTitleCandidate.artist}`.replace(/\.\s+\./g, '.').trim()
      : null;
    const title = titleCandidate || derived?.title || null;
    const artist = filenameArtistFromTitle
      || combinedSplitArtist
      || (suspiciousArtistCandidate ? derived?.artist ?? null : null)
      || cleanedArtistCandidate
      || splitTitleCandidate?.artist
      || derived?.artist
      || null;
    if (!title || !artist || /^\d{1,4}$/u.test(artist)) continue;

    const dedupeKey = `${artist.toLowerCase()}|${title.toLowerCase()}`;
    if (dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);

    tracks.push({
      title,
      artist,
      album: albumCandidate || null,
      spotifyUrl: null,
      position: tracks.length + 1,
    });

    if (tracks.length >= maxTracks) break;
  }

  return {
    name: normalizePlaylistName(fileName),
    tracks,
  };
}

function parseCsvBuffer(fileName: string, buffer: Buffer, maxTracks: number): ExportifyPlaylistImport {
  const baseText = normalizeCsvCharacters(decodeCsvText(buffer));
  if (isMp3tagCsv(baseText)) {
    return parseMp3tagCsvBuffer(fileName, baseText, maxTracks);
  }
  const delimiter = detectCsvDelimiter(baseText);
  let records: Record<string, unknown>[] = [];
  let lastError: unknown = null;

  for (const candidate of [
    baseText,
    sanitizeMalformedCsvQuotes(baseText, delimiter),
    sanitizeMalformedCsvQuotes(baseText.replace(/^\uFEFF/, ''), delimiter),
  ]) {
    try {
      records = parseCsvRecords(candidate, delimiter);
      if (records.length > 0) break;
    } catch (err) {
      lastError = err;
    }
  }

  if (records.length === 0 && lastError) {
    throw lastError;
  }

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

