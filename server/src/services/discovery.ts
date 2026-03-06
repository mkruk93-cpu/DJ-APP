import { getCuratedGenreRule, listCuratedGenreRules } from './genreCuratedConfig.js';
import { spawn } from 'node:child_process';

export interface GenreItem {
  id: string;
  name: string;
}

export interface GenreHitItem {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  sourceHint: string;
  duration?: number | null;
}

const LASTFM_API_KEY = process.env.LASTFM_API_KEY?.trim() ?? '';
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID?.trim() ?? '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET?.trim() ?? '';
let spotifyTokenCache: { token: string; expiresAt: number } | null = null;

type ExternalProvider = 'spotify' | 'deezer';

type ProviderHealth = {
  failCount: number;
  cooldownUntil: number;
};

const providerHealth: Record<ExternalProvider, ProviderHealth> = {
  spotify: { failCount: 0, cooldownUntil: 0 },
  deezer: { failCount: 0, cooldownUntil: 0 },
};

const BASE_PROVIDER_COOLDOWN_MS = 45_000;
const MAX_PROVIDER_COOLDOWN_MS = 4 * 60_000;

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? 'unknown');
}

function isTimeoutLikeError(err: unknown): boolean {
  const message = getErrorMessage(err).toLowerCase();
  return message.includes('timeout')
    || message.includes('aborted')
    || message.includes('aborterror');
}

function shouldUseProvider(name: ExternalProvider): boolean {
  const state = providerHealth[name];
  return state.cooldownUntil <= Date.now();
}

function markProviderSuccess(name: ExternalProvider): void {
  providerHealth[name] = { failCount: 0, cooldownUntil: 0 };
}

function markProviderFailure(name: ExternalProvider, err: unknown): void {
  const state = providerHealth[name];
  const now = Date.now();
  state.failCount += 1;
  if (!isTimeoutLikeError(err)) return;

  if (state.failCount >= 3) {
    const exp = Math.min(state.failCount - 3, 3);
    const cooldown = Math.min(BASE_PROVIDER_COOLDOWN_MS * (2 ** exp), MAX_PROVIDER_COOLDOWN_MS);
    state.cooldownUntil = now + cooldown;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DEFAULT_POPULAR_GENRES = [
  'hardcore',
  'uptempo',
  'gabber',
  'industrial hardcore',
  'krach',
  'terror',
  'terrorcore',
  'mainstream hardcore',
  'happy hardcore',
  'hardstyle',
  'euphoric hardstyle',
  'rawstyle',
  'frenchcore',
  'techno',
  'hard techno',
  'trance',
  'psy trance',
  'psytrance',
  'deep house',
  'future house',
  'house',
  'tech house',
  'progressive house',
  'electro house',
  'drum and bass',
  'liquid drum and bass',
  'neurofunk',
  'bass house',
  'big room',
  'melodic techno',
  'hard dance',
  'dubstep',
  'brostep',
  'uk garage',
  'rock',
  'alternative',
  'alternative rock',
  'indie rock',
  'metal',
  'heavy metal',
  'metalcore',
  'death metal',
  'punk',
  'pop punk',
  'edm',
  'dance',
  'hiphop',
  'nederlandse hiphop',
  'nederlands',
  'top 40',
  'pop',
];

const ALLOWED_GENRE_SET = new Set(DEFAULT_POPULAR_GENRES.map((g) => normalizeGenreName(g)));

interface GenreHints {
  spotifyQueries: string[];
  lastFmTags: string[];
  deezerQueries: string[];
  relevanceTokens: string[];
  avoidTokens: string[];
  requiredTokens?: string[];
  priorityArtists?: string[];
  blockedArtists?: string[];
  priorityTracks?: string[];
  blockedTracks?: string[];
  blockedTokens?: string[];
  priorityLabels?: string[];
  minScore: number;
}

const DEFAULT_PRIORITY_ARTISTS_BY_GENRE: Record<string, string[]> = {
  hardcore: ['angerfist', 'mad dog', 'miss k8'],
  uptempo: ['dimitri k', 'major conspiracy', 'barber'],
  gabber: ['paul elstak', 'neophyte', 'promo'],
  'industrial hardcore': ['ophidian', 'the outside agency', 'detest'],
  krach: ['noiseflow', 'dr donk', 'kior'],
  terror: ['noisekick', 'negative a', 'akira'],
  terrorcore: ['tripped', 'srb', 'tieum'],
  'mainstream hardcore': ['angerfist', 'evil activities', 'outblast'],
  'happy hardcore': ['paul elstak', 'hixxy', 'darren styles'],
  hardstyle: ['headhunterz', 'sub zero project', 'brennan heart'],
  'euphoric hardstyle': ['wildstylez', 'atmozfears', 'adrenalize'],
  rawstyle: ['warface', 'rejecta', 'd-sturb'],
  frenchcore: ['dr peacock', 'sefa', 'billx'],
  techno: ['charlotte de witte', 'amelie lens', 'adam beyer'],
  'hard techno': ['nico moreno', 'trym', 'alignment'],
  trance: ['armin van buuren', 'ferry corsten', 'above & beyond'],
  'psy trance': ['astrix', 'vini vici', 'infected mushroom'],
  psytrance: ['astrix', 'vini vici', 'blastoyz'],
  house: ['fisher', 'chris lake', 'dom dolla'],
  'deep house': ['nora en pure', 'lane 8', 'ben bohmer'],
  'future house': ['don diablo', 'oliver heldens', 'mesto'],
  'tech house': ['john summit', 'mau p', 'cloonee'],
  'progressive house': ['eric prydz', 'nicky romero', 'alesso'],
  'electro house': ['deadmau5', 'zedd', 'knife party'],
  'drum and bass': ['sub focus', 'dimension', 'netsky'],
  'liquid drum and bass': ['hybrid minds', 'maduk', 'fred v'],
  neurofunk: ['noisia', 'black sun empire', 'phace'],
  'bass house': ['joyryde', 'habstrakt', 'jauz'],
  'big room': ['hardwell', 'martin garrix', 'w&w'],
  'melodic techno': ['tale of us', 'artbat', 'anyma'],
  'hard dance': ['coone', 'da tweekaz', 'frontliner'],
  dubstep: ['skrillex', 'zomboy', 'virtual riot'],
  brostep: ['skrillex', 'doctor p', 'knife party'],
  'uk garage': ['sammy virji', 'mj cole', 'conducta'],
  rock: ['foo fighters', 'red hot chili peppers', 'muse'],
  alternative: ['arctic monkeys', 'the killers', 'radiohead'],
  'alternative rock': ['foo fighters', 'paramore', 'kings of leon'],
  'indie rock': ['the strokes', 'tame impala', 'phoenix'],
  metal: ['metallica', 'slipknot', 'iron maiden'],
  'heavy metal': ['iron maiden', 'judas priest', 'black sabbath'],
  metalcore: ['bring me the horizon', 'architects', 'parkway drive'],
  'death metal': ['cannibal corpse', 'death', 'morbid angel'],
  punk: ['ramones', 'the clash', 'bad religion'],
  'pop punk': ['blink-182', 'sum 41', 'all time low'],
  edm: ['martin garrix', 'david guetta', 'avicii'],
  dance: ['calvin harris', 'meduza', 'topic'],
  hiphop: ['drake', 'kendrick lamar', 'travis scott'],
  'nederlandse hiphop': ['boef', 'frenna', 'ronnie flex'],
  nederlands: ['snelle', 'suzan & freek', 'maan'],
  'top 40': ['dua lipa', 'the weeknd', 'taylor swift'],
  pop: ['dua lipa', 'ariana grande', 'ed sheeran'],
};

function getDefaultPriorityArtists(genre: string, mergedTags: string[]): string[] {
  const normalized = resolveMergedGenreId(genre);
  const mapped = DEFAULT_PRIORITY_ARTISTS_BY_GENRE[normalized] ?? [];
  if (mapped.length > 0) return dedupeNormalized(mapped);
  const tagSeeds = mergedTags
    .map((tag) => normalizeGenreName(tag))
    .filter(Boolean)
    .slice(0, 2)
    .map((tag) => `${tag} music`);
  return dedupeNormalized(tagSeeds);
}

function normalizeGenreName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ');
}

interface MergedGenreCluster {
  canonical: string;
  aliases: string[];
  tags: string[];
}

const MERGED_GENRE_CLUSTERS: MergedGenreCluster[] = [
  {
    canonical: 'house',
    aliases: ['tech house'],
    tags: ['house', 'tech house'],
  },
  {
    canonical: 'pop',
    aliases: ['top 40', 'nederlands'],
    tags: ['pop', 'top 40', 'nederlands', 'nederlandstalig', 'dutch pop', 'nl pop'],
  },
  {
    canonical: 'terror',
    aliases: ['terrorcore'],
    tags: ['terror', 'terrorcore', 'speedcore', 'hardcore terror'],
  },
  {
    canonical: 'psy trance',
    aliases: ['psytrance'],
    tags: ['psy trance', 'psytrance', 'goa', 'psychedelic trance'],
  },
  {
    canonical: 'drum and bass',
    aliases: ['liquid drum and bass', 'neurofunk'],
    tags: [
      'drum and bass',
      'dnb',
      'liquid drum and bass',
      'liquid dnb',
      'neurofunk',
      'neuro dnb',
    ],
  },
  {
    canonical: 'dubstep',
    aliases: ['brostep'],
    tags: ['dubstep', 'brostep', 'riddim', 'bass music'],
  },
];

const MERGED_GENRE_ALIAS_TO_CANONICAL = new Map<string, string>();
const MERGED_GENRE_CANONICAL_TO_TAGS = new Map<string, string[]>();
const MERGED_GENRE_CANONICAL_TO_FAMILY = new Map<string, string[]>();

for (const cluster of MERGED_GENRE_CLUSTERS) {
  const canonical = normalizeGenreName(cluster.canonical);
  const aliases = cluster.aliases.map((value) => normalizeGenreName(value)).filter(Boolean);
  const family = Array.from(new Set([canonical, ...aliases]));
  const tags = Array.from(new Set(
    [canonical, ...aliases, ...cluster.tags.map((value) => normalizeGenreName(value)).filter(Boolean)],
  ));
  MERGED_GENRE_CANONICAL_TO_FAMILY.set(canonical, family);
  MERGED_GENRE_CANONICAL_TO_TAGS.set(canonical, tags);
  for (const member of family) {
    MERGED_GENRE_ALIAS_TO_CANONICAL.set(member, canonical);
  }
}

export function resolveMergedGenreId(genre: string): string {
  const normalized = normalizeGenreName(genre);
  return MERGED_GENRE_ALIAS_TO_CANONICAL.get(normalized) ?? normalized;
}

function getMergedGenreFamily(genre: string): string[] {
  const canonical = resolveMergedGenreId(genre);
  return MERGED_GENRE_CANONICAL_TO_FAMILY.get(canonical) ?? [canonical];
}

export function getMergedGenreTags(genre: string): string[] {
  const canonical = resolveMergedGenreId(genre);
  return MERGED_GENRE_CANONICAL_TO_TAGS.get(canonical) ?? [canonical];
}

/** Removes noisy suffixes/tags from titles used in deduplication keys. */
const TITLE_NOISE_RE = /\s*[\(\[](official\s*(music\s*)?video|official\s*audio|hq|lyrics?|audio|full\s*stream|visuali[sz]er|clip\s*officiel)[\)\]]/gi;
/** Removes year-only tags like "(2024)" or "[2023]" from dedupe keys. */
const YEAR_TAG_RE = /\s*[\(\[]20[0-9]{2}[\)\]]/g;

export function normalizeTrackIdentity(artist: string, title: string): string {
  const cleanArtist = artist.trim();
  const cleanTitle = title
    .replace(TITLE_NOISE_RE, '')
    .replace(YEAR_TAG_RE, '')
    .trim();
  return `${cleanArtist}-${cleanTitle}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeNormalized(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const normalized = normalizeGenreName(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function isAllowedGenre(genre: string): boolean {
  const normalized = resolveMergedGenreId(genre);
  if (!normalized) return false;
  if (ALLOWED_GENRE_SET.has(normalized)) return true;
  return !!getCuratedGenreRule(normalized);
}

export function isKnownDiscoveryGenre(genre: string): boolean {
  return isAllowedGenre(genre);
}

function getGenreHints(genre: string): GenreHints {
  const requestedNormalized = normalizeGenreName(genre);
  const normalized = resolveMergedGenreId(requestedNormalized);
  const mergedFamily = getMergedGenreFamily(normalized);
  const mergedTags = getMergedGenreTags(normalized);
  const baseGenreTokens = mergedTags
    .flatMap((value) => value.split(' '))
    .filter((token) => token.length >= 3);
  const defaultRelevanceTokens = Array.from(new Set([...mergedFamily, ...mergedTags, ...baseGenreTokens]));
  if (normalized.includes('drum and bass')) defaultRelevanceTokens.push('dnb');
  if (normalized.includes('dnb')) defaultRelevanceTokens.push('drum and bass');
  if (normalized.includes('hardstyle')) defaultRelevanceTokens.push('rawstyle');
  if (normalized.includes('psy trance')) defaultRelevanceTokens.push('psytrance');
  if (normalized.includes('psytrance')) defaultRelevanceTokens.push('psy trance');
  const hints: Record<string, GenreHints> = {
    hardcore: {
      spotifyQueries: ['genre:"hardcore" gabber hardcore dance', 'gabber hardcore uptempo'],
      lastFmTags: ['gabber', 'hardcore'],
      deezerQueries: ['gabber hardcore', 'uptempo hardcore'],
      relevanceTokens: ['hardcore', 'gabber', 'uptempo', 'frenchcore', 'rawstyle'],
      avoidTokens: ['house', 'afrobeats', 'latin pop'],
      minScore: 2,
    },
    'industrial hardcore': {
      spotifyQueries: ['industrial hardcore darkcore gabber', 'hardcore industrial'],
      lastFmTags: ['industrial hardcore', 'hardcore'],
      deezerQueries: ['industrial hardcore', 'darkcore hardcore'],
      relevanceTokens: ['industrial', 'darkcore', 'hardcore', 'gabber'],
      avoidTokens: ['house', 'pop'],
      minScore: 2,
    },
    krach: {
      spotifyQueries: ['krach hardcore zaag', 'hardcore krach'],
      lastFmTags: ['gabber', 'hardcore'],
      deezerQueries: ['krach hardcore', 'deutscher krach'],
      relevanceTokens: ['krach', 'zaag', 'saw', 'hardcore'],
      avoidTokens: ['gabber', 'early hardcore', 'house', 'trance'],
      minScore: 2,
    },
    terror: {
      spotifyQueries: ['terror hardcore terrorcore', 'speedcore terror'],
      lastFmTags: ['terrorcore', 'hardcore'],
      deezerQueries: ['terrorcore hardcore', 'terror hardcore'],
      relevanceTokens: ['terror', 'terrorcore', 'speedcore', 'hardcore'],
      avoidTokens: ['house', 'afrobeats'],
      minScore: 2,
    },
    terrorcore: {
      spotifyQueries: ['terrorcore speedcore hardcore', 'terrorcore'],
      lastFmTags: ['terrorcore', 'speedcore'],
      deezerQueries: ['terrorcore', 'speedcore hardcore'],
      relevanceTokens: ['terrorcore', 'speedcore', 'terror', 'hardcore'],
      avoidTokens: ['house', 'pop'],
      minScore: 2,
    },
    hardstyle: {
      spotifyQueries: ['genre:"hardstyle" hardstyle rawstyle', 'hardstyle rawstyle euphoric'],
      lastFmTags: ['hardstyle', 'rawstyle'],
      deezerQueries: ['hardstyle rawstyle', 'hard dance hardstyle'],
      relevanceTokens: ['hardstyle', 'rawstyle', 'euphoric', 'defqon', 'qlimax'],
      avoidTokens: ['house', 'afrobeats', 'reggaeton'],
      minScore: 2,
    },
    'euphoric hardstyle': {
      spotifyQueries: ['euphoric hardstyle melodic hardstyle', 'hardstyle euphoric anthem'],
      lastFmTags: ['hardstyle', 'euphoric hardstyle'],
      deezerQueries: ['euphoric hardstyle', 'melodic hardstyle'],
      relevanceTokens: ['euphoric', 'hardstyle', 'melodic', 'anthem'],
      avoidTokens: ['terror', 'industrial'],
      minScore: 2,
    },
    techno: {
      spotifyQueries: ['genre:"techno" peak time techno', 'techno warehouse rave'],
      lastFmTags: ['techno'],
      deezerQueries: ['techno', 'peak time techno'],
      relevanceTokens: ['techno', 'acid', 'warehouse', 'rave', 'hard techno'],
      avoidTokens: ['hip hop', 'reggaeton', 'afrobeats'],
      minScore: 2,
    },
    trance: {
      spotifyQueries: ['trance uplifting trance vocal trance', 'trance progressive trance'],
      lastFmTags: ['trance'],
      deezerQueries: ['trance', 'uplifting trance'],
      relevanceTokens: ['trance', 'uplifting', 'vocal trance', 'asot', 'psy'],
      avoidTokens: ['hardcore', 'hip hop'],
      minScore: 2,
    },
    'psy trance': {
      spotifyQueries: ['psy trance psytrance full on', 'psychedelic trance'],
      lastFmTags: ['psytrance', 'psy trance'],
      deezerQueries: ['psy trance', 'psytrance'],
      relevanceTokens: ['psy', 'psytrance', 'psy trance', 'goa'],
      avoidTokens: ['house', 'hip hop'],
      minScore: 2,
    },
    psytrance: {
      spotifyQueries: ['psytrance psy trance full on', 'psychedelic trance'],
      lastFmTags: ['psytrance', 'psy trance'],
      deezerQueries: ['psytrance', 'psy trance'],
      relevanceTokens: ['psytrance', 'psy trance', 'goa', 'psy'],
      avoidTokens: ['house', 'hip hop'],
      minScore: 2,
    },
    'deep house': {
      spotifyQueries: ['deep house soulful deep house', 'deep house melodic house'],
      lastFmTags: ['deep house', 'house'],
      deezerQueries: ['deep house', 'melodic deep house'],
      relevanceTokens: ['deep house', 'deep', 'house', 'melodic'],
      avoidTokens: ['hardcore', 'terror'],
      minScore: 2,
    },
    'future house': {
      spotifyQueries: ['future house bass house', 'future house edm'],
      lastFmTags: ['future house', 'house'],
      deezerQueries: ['future house', 'future bass house'],
      relevanceTokens: ['future house', 'future', 'house', 'bass house'],
      avoidTokens: ['hardcore', 'terror'],
      minScore: 2,
    },
    dubstep: {
      spotifyQueries: ['dubstep brostep bass music', 'dubstep riddim'],
      lastFmTags: ['dubstep', 'brostep'],
      deezerQueries: ['dubstep', 'brostep'],
      relevanceTokens: ['dubstep', 'brostep', 'riddim', 'bass'],
      avoidTokens: ['trance', 'hardstyle'],
      minScore: 2,
    },
    'liquid drum and bass': {
      spotifyQueries: ['liquid drum and bass melodic dnb', 'liquid dnb drum and bass'],
      lastFmTags: ['liquid drum and bass', 'drum and bass'],
      deezerQueries: ['liquid drum and bass', 'liquid dnb'],
      relevanceTokens: ['liquid', 'drum and bass', 'dnb', 'liquid dnb', 'neurofunk'],
      avoidTokens: ['hardstyle', 'trance', 'house'],
      minScore: 2,
    },
    liquid_drum_and_bass: {
      spotifyQueries: ['liquid drum and bass melodic dnb', 'liquid dnb drum and bass'],
      lastFmTags: ['liquid drum and bass', 'drum and bass'],
      deezerQueries: ['liquid drum and bass', 'liquid dnb'],
      relevanceTokens: ['liquid', 'drum and bass', 'dnb', 'liquid dnb', 'neurofunk'],
      avoidTokens: ['hardstyle', 'trance', 'house'],
      minScore: 2,
    },
    rock: {
      spotifyQueries: ['rock anthems modern rock', 'classic rock alternative rock'],
      lastFmTags: ['rock'],
      deezerQueries: ['rock', 'modern rock'],
      relevanceTokens: ['rock', 'guitar', 'band', 'anthem'],
      avoidTokens: ['hardcore', 'techno'],
      minScore: 2,
    },
    alternative: {
      spotifyQueries: ['alternative alternative rock indie', 'alt rock'],
      lastFmTags: ['alternative', 'alternative rock'],
      deezerQueries: ['alternative rock', 'alternative'],
      relevanceTokens: ['alternative', 'alt', 'indie', 'rock'],
      avoidTokens: ['hardcore', 'terror'],
      minScore: 2,
    },
    metal: {
      spotifyQueries: ['metal heavy metal', 'metalcore melodic metal'],
      lastFmTags: ['metal', 'heavy metal'],
      deezerQueries: ['metal', 'heavy metal'],
      relevanceTokens: ['metal', 'heavy', 'riff', 'core'],
      avoidTokens: ['house', 'trance'],
      minScore: 2,
    },
    hiphop: {
      spotifyQueries: ['genre:"hip hop" hip hop rap', 'hip hop rap nl'],
      lastFmTags: ['hip-hop', 'rap'],
      deezerQueries: ['hip hop rap', 'nederlandse hiphop'],
      relevanceTokens: ['hip hop', 'hiphop', 'rap', 'drill', 'trap'],
      avoidTokens: ['hardstyle', 'trance', 'techno'],
      minScore: 2,
    },
    nederlands: {
      spotifyQueries: ['nederlandstalig nederlands hits dutch', 'nederlandse pop'],
      lastFmTags: ['dutch', 'nederlandstalig'],
      deezerQueries: ['nederlandstalig', 'nederlandse hits'],
      relevanceTokens: ['nederlands', 'nederlandstalig', 'dutch', 'holland'],
      avoidTokens: ['k-pop', 'afrobeats'],
      minScore: 2,
    },
  };

  const baseCandidates = Array.from(
    new Set([requestedNormalized, normalized, ...mergedFamily]),
  )
    .map((id) => hints[id])
    .filter((item): item is GenreHints => !!item);

  const base = baseCandidates.length > 0
    ? {
      spotifyQueries: dedupeNormalized(baseCandidates.flatMap((item) => item.spotifyQueries)),
      lastFmTags: dedupeNormalized(baseCandidates.flatMap((item) => item.lastFmTags)),
      deezerQueries: dedupeNormalized(baseCandidates.flatMap((item) => item.deezerQueries)),
      relevanceTokens: dedupeNormalized([
        ...defaultRelevanceTokens,
        ...baseCandidates.flatMap((item) => item.relevanceTokens),
      ]),
      avoidTokens: dedupeNormalized(baseCandidates.flatMap((item) => item.avoidTokens)),
      requiredTokens: dedupeNormalized(baseCandidates.flatMap((item) => item.requiredTokens ?? [])),
      priorityArtists: dedupeNormalized(baseCandidates.flatMap((item) => item.priorityArtists ?? [])),
      blockedArtists: dedupeNormalized(baseCandidates.flatMap((item) => item.blockedArtists ?? [])),
      priorityTracks: dedupeNormalized(baseCandidates.flatMap((item) => item.priorityTracks ?? [])),
      blockedTracks: dedupeNormalized(baseCandidates.flatMap((item) => item.blockedTracks ?? [])),
      priorityLabels: dedupeNormalized(baseCandidates.flatMap((item) => item.priorityLabels ?? [])),
      minScore: baseCandidates.reduce((acc, item) => Math.max(acc, item.minScore), 1),
    } satisfies GenreHints
    : {
      spotifyQueries: [`genre:"${genre}" ${genre}`, genre],
      lastFmTags: [genre],
      deezerQueries: [genre],
      relevanceTokens: dedupeNormalized(defaultRelevanceTokens),
      avoidTokens: [],
      minScore: 1,
    };

  const curatedRules = mergedFamily
    .map((id) => getCuratedGenreRule(id))
    .filter((rule): rule is NonNullable<ReturnType<typeof getCuratedGenreRule>> => !!rule);

  if (curatedRules.length === 0) {
    return {
      ...base,
      requiredTokens: base.requiredTokens ?? [],
      priorityArtists: base.priorityArtists ?? [],
      blockedArtists: [],
      priorityTracks: base.priorityTracks ?? [],
      blockedTracks: [],
      blockedTokens: [],
      priorityLabels: base.priorityLabels ?? [],
    };
  }

  const mergedCuratedRequired = dedupeNormalized(curatedRules.flatMap((rule) => rule.requiredTokens ?? []));
  const mergedCuratedPriorityArtists = dedupeNormalized(curatedRules.flatMap((rule) => rule.priorityArtists ?? []));
  const mergedCuratedBlockedArtists = dedupeNormalized(curatedRules.flatMap((rule) => rule.blockedArtists ?? []));
  const mergedCuratedPriorityTracks = dedupeNormalized(curatedRules.flatMap((rule) => rule.priorityTracks ?? []));
  const mergedCuratedBlockedTracks = dedupeNormalized(curatedRules.flatMap((rule) => rule.blockedTracks ?? []));
  const mergedCuratedPriorityLabels = dedupeNormalized(curatedRules.flatMap((rule) => rule.priorityLabels ?? []));
  const mergedCuratedBlockedTokens = dedupeNormalized(curatedRules.flatMap((rule) => rule.blockedTokens ?? []));
  const mergedMinScore = curatedRules.reduce((acc, rule) => {
    const value = typeof rule.minScore === 'number' ? rule.minScore : acc;
    return Math.max(acc, value);
  }, base.minScore);

  return {
    spotifyQueries: dedupeNormalized([...base.spotifyQueries, ...mergedCuratedRequired]),
    lastFmTags: dedupeNormalized([...base.lastFmTags, ...mergedCuratedRequired.slice(0, 2)]),
    deezerQueries: dedupeNormalized([...base.deezerQueries, ...mergedCuratedRequired]),
    relevanceTokens: dedupeNormalized([...base.relevanceTokens, ...mergedCuratedRequired, ...mergedTags]),
    avoidTokens: dedupeNormalized([...base.avoidTokens, ...mergedCuratedBlockedTokens]),
    requiredTokens: dedupeNormalized([...(base.requiredTokens ?? []), ...mergedCuratedRequired]),
    priorityArtists: dedupeNormalized([
      ...(base.priorityArtists ?? []),
      ...mergedCuratedPriorityArtists,
      ...getDefaultPriorityArtists(normalized, mergedTags),
    ]),
    blockedArtists: mergedCuratedBlockedArtists,
    priorityTracks: dedupeNormalized([...(base.priorityTracks ?? []), ...mergedCuratedPriorityTracks]),
    blockedTracks: mergedCuratedBlockedTracks,
    blockedTokens: mergedCuratedBlockedTokens,
    priorityLabels: dedupeNormalized([...(base.priorityLabels ?? []), ...mergedCuratedPriorityLabels]),
    minScore: mergedMinScore,
  };
}

export function getPriorityArtistsForGenre(genre: string): string[] {
  const hints = getGenreHints(genre);
  const seeded = hints.priorityArtists ?? [];
  if (seeded.length > 0) return seeded;
  return getDefaultPriorityArtists(genre, getMergedGenreTags(genre));
}

function scoreGenreRelevance(item: GenreHitItem, hints: GenreHints): number {
  const text = `${item.artist} ${item.title} ${item.sourceHint}`.toLowerCase();
  let score = 0;
  for (const token of hints.relevanceTokens) {
    if (!token) continue;
    const normalized = token.toLowerCase();
    if (text.includes(normalized)) score += normalized.includes(' ') ? 4 : 3;
  }
  for (const token of hints.avoidTokens) {
    if (!token) continue;
    if (text.includes(token.toLowerCase())) score -= 5;
  }
  for (const artist of hints.priorityArtists ?? []) {
    if (!artist) continue;
    if (item.artist.toLowerCase().includes(artist.toLowerCase())) score += 16;
  }
  for (const track of hints.priorityTracks ?? []) {
    if (!track) continue;
    if (item.title.toLowerCase().includes(track.toLowerCase())) score += 11;
  }
  for (const label of hints.priorityLabels ?? []) {
    if (!label) continue;
    if (text.includes(label.toLowerCase())) score += 6;
  }
  return score;
}

function hasRequiredEvidence(item: GenreHitItem, hints: GenreHints): boolean {
  const required = hints.requiredTokens ?? [];
  const artistPriors = hints.priorityArtists ?? [];
  const labelPriors = hints.priorityLabels ?? [];
  if (required.length === 0 && artistPriors.length === 0 && labelPriors.length === 0) {
    return true;
  }

  const artistText = item.artist.toLowerCase();
  const fullText = `${item.artist} ${item.title} ${item.sourceHint}`.toLowerCase();
  if (artistPriors.some((value) => artistText.includes(value.toLowerCase()))) return true;
  if (labelPriors.some((value) => fullText.includes(value.toLowerCase()))) return true;
  if (required.some((value) => fullText.includes(value.toLowerCase()))) return true;
  return false;
}

function filterHitsByGenre(items: GenreHitItem[], hints: GenreHints, limit: number): GenreHitItem[] {
  const blocked = new Set((hints.blockedTracks ?? []).map((value) => value.toLowerCase()));
  const blockedArtists = (hints.blockedArtists ?? []).map((value) => value.toLowerCase());
  const blockedTokens = (hints.blockedTokens ?? []).map((value) => value.toLowerCase());
  const scored = dedupeHits(items)
    .filter((item) => {
      if (isLikelyGenreNameOnlyHit(item, hints)) return false;
      if (isGenreKeywordNoiseHit(item, hints)) return false;
      const artist = item.artist.toLowerCase();
      const title = item.title.toLowerCase();
      const artistTitle = `${item.artist} - ${item.title}`.toLowerCase();
      
      // Check blocked artists
      if (blockedArtists.some((blockedArtist) => blockedArtist && artist.includes(blockedArtist))) {
        return false;
      }
      
      // Check blocked tokens in title and artist
      if (blockedTokens.some((token) => token && (title.includes(token) || artist.includes(token) || artistTitle.includes(token)))) {
        console.log(`[filter] Blocked by token: ${item.artist} - ${item.title}`);
        return false;
      }
      
      // Check blocked tracks
      if (blocked.size > 0) {
        for (const blockedTrack of blocked) {
          if (!blockedTrack) continue;
          if (title.includes(blockedTrack) || artistTitle.includes(blockedTrack)) {
            return false;
          }
        }
      }
      
      return true;
    })
    .map((item) => ({
      item,
      score: scoreGenreRelevance(item, hints),
      evidence: hasRequiredEvidence(item, hints),
    }))
    .filter((row) => {
      const duration = row.item.duration;
      if (duration == null) return true;
      return duration >= 120 && duration <= 600;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Math.random() - 0.5;
    });

  return scored
    .filter((row) => row.evidence && row.score >= hints.minScore)
    .map((row) => row.item)
    .slice(0, limit);
}

function dedupeHits(items: GenreHitItem[]): GenreHitItem[] {
  return Array.from(
    new Map(
      items.map((item) => [
        normalizeTrackIdentity(item.artist, item.title),
        item,
      ]),
    ).values(),
  );
}

function normalizeLooseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyGenreNameOnlyHit(item: GenreHitItem, hints: GenreHints): boolean {
  const title = normalizeLooseText(item.title);
  const artist = normalizeLooseText(item.artist);
  if (!title) return true;

  const genreTokens = [
    ...hints.relevanceTokens,
    ...(hints.requiredTokens ?? []),
  ]
    .map(normalizeLooseText)
    .filter(Boolean);

  // Common wrong-hit pattern: title is just the genre keyword itself.
  if (genreTokens.some((token) => token === title)) return true;

  // Another wrong-hit pattern: both artist and title collapse to genre terms only.
  if (
    artist &&
    genreTokens.some((token) => artist === token || artist.includes(token)) &&
    genreTokens.some((token) => title.includes(token))
  ) {
    const titleWordCount = title.split(' ').filter(Boolean).length;
    if (titleWordCount <= 2) return true;
  }

  return false;
}

function isGenreKeywordNoiseHit(item: GenreHitItem, hints: GenreHints): boolean {
  const title = normalizeLooseText(item.title);
  const artist = normalizeLooseText(item.artist);
  if (!title && !artist) return true;

  const hasPriorityArtist = (hints.priorityArtists ?? []).some((value) => {
    const token = normalizeLooseText(value);
    return token.length > 0 && artist.includes(token);
  });
  if (hasPriorityArtist) return false;

  const hasPriorityTrack = (hints.priorityTracks ?? []).some((value) => {
    const token = normalizeLooseText(value);
    return token.length > 0 && title.includes(token);
  });
  if (hasPriorityTrack) return false;

  const genreTokens = [
    ...hints.relevanceTokens,
    ...(hints.requiredTokens ?? []),
  ]
    .map(normalizeLooseText)
    .filter((token) => token.length >= 3);
  if (genreTokens.length === 0) return false;

  const wordsAreGenreOnly = (value: string): boolean => {
    const words = value.split(' ').filter(Boolean);
    if (words.length === 0) return false;
    return words.every((word) => genreTokens.some((token) => token.includes(word) || word.includes(token)));
  };

  // Conservative noise check: only reject when both fields collapse to genre-only words.
  return wordsAreGenreOnly(title) && wordsAreGenreOnly(artist);
}

function makeUniqueGenreMap(): Map<string, GenreItem> {
  const map = new Map<string, GenreItem>();
  for (const genre of DEFAULT_POPULAR_GENRES) {
    const normalized = resolveMergedGenreId(genre);
    if (!map.has(normalized)) {
      map.set(normalized, { id: normalized, name: genre });
    }
  }
  for (const rule of listCuratedGenreRules()) {
    const normalized = resolveMergedGenreId(rule.id);
    if (!normalized || map.has(normalized)) continue;
    map.set(normalized, {
      id: normalized,
      name: rule.label?.trim() || normalized,
    });
  }
  return map;
}

async function fetchDeezerGenres(): Promise<GenreItem[]> {
  const res = await fetch('https://api.deezer.com/genre', {
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`Deezer genre HTTP ${res.status}`);
  }

  const data = await res.json() as { data?: Array<{ id?: number; name?: string }> };
  const genres = data.data ?? [];
  return genres
    .map((g) => {
      const name = (g.name ?? '').trim();
      if (!name || name.toLowerCase() === 'all') return null;
      return {
        id: String(g.id ?? normalizeGenreName(name)),
        name,
      } satisfies GenreItem;
    })
    .filter((item): item is GenreItem => item !== null);
}

export async function searchGenres(query?: string): Promise<GenreItem[]> {
  const uniqueGenres = makeUniqueGenreMap();
  const q = normalizeGenreName(query ?? '');
  const genreOrder = new Map<string, number>();
  DEFAULT_POPULAR_GENRES.forEach((name, index) => {
    const normalized = resolveMergedGenreId(name);
    if (!genreOrder.has(normalized)) {
      genreOrder.set(normalized, index);
    }
  });
  const curatedRules = listCuratedGenreRules();
  for (const rule of curatedRules) {
    const normalized = resolveMergedGenreId(rule.id);
    if (!genreOrder.has(normalized)) {
      genreOrder.set(normalized, DEFAULT_POPULAR_GENRES.length + genreOrder.size);
    }
  }

  let items = [...uniqueGenres.values()];
  if (q) {
    items = items.filter((genre) => {
      const normalizedName = normalizeGenreName(genre.name);
      if (normalizedName.includes(q)) return true;
      return getMergedGenreTags(genre.id).some((tag) => tag.includes(q));
    });
  }

  return items
    .sort((a, b) => {
      const orderA = genreOrder.get(resolveMergedGenreId(a.name)) ?? Number.MAX_SAFE_INTEGER;
      const orderB = genreOrder.get(resolveMergedGenreId(b.name)) ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name, 'nl', { sensitivity: 'base' });
    })
    .slice(0, 80);
}

function mapTrackToHit(item: Record<string, unknown>): GenreHitItem | null {
  const title = String(item.title ?? '').trim();
  const artist = String((item.artist as { name?: string } | undefined)?.name ?? '').trim();
  const link = String(item.link ?? '').trim();
  if (!title || !artist) return null;

  const cover = String((item.album as { cover_medium?: string } | undefined)?.cover_medium ?? '').trim();
  const id = String(item.id ?? `${artist}-${title}`);
  const rawDuration = Number(item.duration ?? NaN);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.round(rawDuration) : null;

  return {
    id,
    title,
    artist,
    thumbnail: cover,
    sourceHint: link,
    duration,
  };
}

async function searchTopTracks(query: string, limit: number, offset: number): Promise<GenreHitItem[]> {
  const params = new URLSearchParams({
    q: query,
    order: 'RANKING',
    limit: String(limit),
    index: String(offset),
  });

  const res = await fetch(`https://api.deezer.com/search/track?${params}`, {
    signal: AbortSignal.timeout(3500),
  });

  if (!res.ok) {
    throw new Error(`Deezer track HTTP ${res.status}`);
  }

  const data = await res.json() as { data?: Array<Record<string, unknown>> };
  const queryHint = normalizeGenreName(query);
  return (data.data ?? [])
    .map(mapTrackToHit)
    .map((item) => (item ? { ...item, sourceHint: `${item.sourceHint} q:${queryHint}`.trim() } : null))
    .filter((item): item is GenreHitItem => item !== null)
    .slice(0, limit);
}

async function getSpotifyAppToken(): Promise<string | null> {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return null;
  if (spotifyTokenCache && Date.now() < spotifyTokenCache.expiresAt) {
    return spotifyTokenCache.token;
  }

  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) {
    throw new Error(`Spotify token HTTP ${res.status}`);
  }

  const data = await res.json() as { access_token?: string; expires_in?: number };
  const token = data.access_token ?? '';
  if (!token) return null;
  const ttlMs = Math.max(60, (data.expires_in ?? 3600) - 60) * 1000;
  spotifyTokenCache = { token, expiresAt: Date.now() + ttlMs };
  return token;
}

async function fetchSpotifyTracksByGenre(
  genre: string,
  limit: number,
  offset: number,
  maxQueries = Number.POSITIVE_INFINITY,
): Promise<GenreHitItem[]> {
  if (!shouldUseProvider('spotify')) return [];
  let token: string | null = null;
  try {
    token = await getSpotifyAppToken();
    markProviderSuccess('spotify');
  } catch (err) {
    markProviderFailure('spotify', err);
    return [];
  }
  if (!token) return [];
  const hints = getGenreHints(genre);

  const buildQuery = (q: string): string => {
    const params = new URLSearchParams({
      q,
      type: 'track',
      market: 'NL',
      limit: String(limit),
      offset: String(offset),
    });
    return `https://api.spotify.com/v1/search?${params}`;
  };

  const mapItems = (items: Array<Record<string, unknown>>): GenreHitItem[] =>
    items
      .map((item): GenreHitItem | null => {
        const title = String(item.name ?? '').trim();
        const artists = Array.isArray(item.artists)
          ? item.artists
              .map((a) => String((a as { name?: string }).name ?? '').trim())
              .filter(Boolean)
              .join(', ')
          : '';
        if (!title || !artists) return null;
        const album = (item.album as { images?: Array<{ url?: string }> } | undefined);
        const image = album?.images?.[1]?.url ?? album?.images?.[0]?.url ?? '';
        const rawDuration = Number(item.duration_ms ?? NaN);
        const duration = Number.isFinite(rawDuration) && rawDuration > 0
          ? Math.round(rawDuration / 1000)
          : null;
        return {
          id: String(item.id ?? `${artists}-${title}`).toLowerCase(),
          title,
          artist: artists,
          thumbnail: image,
          sourceHint: String(((item.external_urls as { spotify?: string } | undefined)?.spotify) ?? ''),
          duration,
        };
      })
      .filter((hit): hit is GenreHitItem => hit !== null);

  const run = async (q: string): Promise<GenreHitItem[]> => {
    const res = await fetch(buildQuery(q), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) {
      throw new Error(`Spotify search HTTP ${res.status}`);
    }
    const data = await res.json() as { tracks?: { items?: Array<Record<string, unknown>> } };
    const queryHint = normalizeGenreName(q);
    return mapItems(data.tracks?.items ?? [])
      .map((item) => ({ ...item, sourceHint: `${item.sourceHint} q:${queryHint}`.trim() }))
      .slice(0, limit);
  };

  const merged: GenreHitItem[] = [];
  for (const query of hints.spotifyQueries.slice(0, Math.max(0, maxQueries))) {
    try {
      const result = await run(query);
      merged.push(...result);
      markProviderSuccess('spotify');
      if (merged.length >= limit * 2) break;
    } catch (err) {
      markProviderFailure('spotify', err);
    }
  }

  return filterHitsByGenre(merged, hints, limit);
}

async function fetchLastFmTopTracksByGenre(
  genre: string,
  limit: number,
  offset: number,
  maxTags = Number.POSITIVE_INFINITY,
): Promise<GenreHitItem[]> {
  if (!LASTFM_API_KEY) return [];
  const hints = getGenreHints(genre);
  const page = Math.floor(offset / Math.max(1, limit)) + 1;
  const merged: GenreHitItem[] = [];

  for (const tag of hints.lastFmTags.slice(0, Math.max(0, maxTags))) {
    const params = new URLSearchParams({
      method: 'tag.gettoptracks',
      tag,
      api_key: LASTFM_API_KEY,
      format: 'json',
      limit: String(limit),
      page: String(page),
    });

    const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`, {
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) {
      throw new Error(`Last.fm HTTP ${res.status}`);
    }

    const data = await res.json() as {
      tracks?: {
        track?: Array<{
          name?: string;
          url?: string;
          artist?: { name?: string };
          image?: Array<{ '#text'?: string; size?: string }>;
        }>;
      };
    };

    merged.push(
      ...(data.tracks?.track ?? [])
        .map((track) => {
          const title = (track.name ?? '').trim();
          const artist = (track.artist?.name ?? '').trim();
          if (!title || !artist) return null;
          const image = track.image ?? [];
          const bestImage = image.find((img) => img.size === 'extralarge' && img['#text'])?.['#text']
            ?? image.find((img) => img.size === 'large' && img['#text'])?.['#text']
            ?? image.find((img) => img['#text'])?.['#text']
            ?? '';
          return {
            id: `${artist}-${title}`.toLowerCase(),
            title,
            artist,
            thumbnail: bestImage,
            sourceHint: `${track.url ?? ''} q:${normalizeGenreName(tag)}`.trim(),
          } satisfies GenreHitItem;
        })
        .filter((item): item is GenreHitItem => item !== null),
    );
  }

  return filterHitsByGenre(merged, hints, limit);
}

async function fetchDeezerTracksByGenre(
  genre: string,
  limit: number,
  offset: number,
  maxQueries = Number.POSITIVE_INFINITY,
): Promise<GenreHitItem[]> {
  if (!shouldUseProvider('deezer')) return [];
  const hints = getGenreHints(genre);
  const merged: GenreHitItem[] = [];
  for (const query of hints.deezerQueries.slice(0, Math.max(0, maxQueries))) {
    try {
      const items = await searchTopTracks(query, limit, offset);
      merged.push(...items);
      markProviderSuccess('deezer');
    } catch (err) {
      markProviderFailure('deezer', err);
    }
  }
  return filterHitsByGenre(merged, hints, limit);
}

function normalizeHitKey(artist: string, title: string): string {
  return normalizeTrackIdentity(artist, title);
}

function shuffleCopy<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function ytdlpSearchPlatform(
  platform: 'yt' | 'sc',
  query: string,
  limit: number,
): Promise<GenreHitItem[]> {
  return new Promise((resolve) => {
    const prefix = platform === 'yt' ? 'ytsearch' : 'scsearch';
    const proc = spawn('python', [
      '-m', 'yt_dlp',
      `${prefix}${limit}:${query}`,
      '--flat-playlist',
      '-j',
      '--no-warnings',
    ], { timeout: 5_000 });

    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on('data', () => {});

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }
      const hits: GenreHitItem[] = [];
      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line) as Record<string, unknown>;
          const title = String(item.title ?? '').trim();
          const artist = String(item.uploader ?? item.channel ?? '').trim();
          if (!title || !artist) continue;
          const thumbnail = Array.isArray(item.thumbnails) && item.thumbnails.length > 0
            ? String((item.thumbnails[item.thumbnails.length - 1] as { url?: string })?.url ?? '').trim()
            : '';
          const sourceHint = String(item.url ?? item.webpage_url ?? '').trim();
          const rawDuration = Number(item.duration ?? NaN);
          const duration = Number.isFinite(rawDuration) && rawDuration > 0
            ? Math.round(rawDuration)
            : null;
          hits.push({
            id: `${platform}-${String(item.id ?? `${artist}-${title}`)}`,
            title,
            artist,
            thumbnail,
            sourceHint: `${sourceHint} q:${normalizeGenreName(query)}`.trim(),
            duration,
          });
        } catch {
          // ignore malformed line
        }
      }
      resolve(hits);
    });

    proc.on('error', () => resolve([]));
  });
}

async function fetchPriorityArtistPlatformHits(
  genre: string,
  hints: GenreHints,
  limit: number,
  offset: number,
  options?: { artistSampleSize?: number; perPlatformLimit?: number; maxRuntimeMs?: number },
): Promise<GenreHitItem[]> {
  const normalizePriorityArtistSeed = (value: string): string => {
    return value
      .split(',')
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? value.trim();
  };

  const artists = [...(hints.priorityArtists ?? [])]
    .map(normalizePriorityArtistSeed)
    .filter(Boolean);
  if (artists.length === 0) return [];
  const sampleSize = Math.max(1, Math.min(options?.artistSampleSize ?? 6, artists.length));
  const perPlatformLimit = Math.max(1, Math.min(options?.perPlatformLimit ?? 5, 8));
  const maxRuntimeMs = Math.max(300, Math.min(options?.maxRuntimeMs ?? 3500, 7000));
  const startedAt = Date.now();
  const page = Math.floor(offset / Math.max(1, limit));
  const start = (page * sampleSize) % artists.length;
  const selected = Array.from({ length: sampleSize }).map((_, index) => {
    const pos = (start + index) % artists.length;
    return artists[pos];
  });

  const results: GenreHitItem[] = [];
  const seen = new Set<string>();

  const settled = await Promise.allSettled(
    selected.map(async (artist) => {
      if (Date.now() - startedAt > maxRuntimeMs) return [] as GenreHitItem[];
      const query = `${artist} ${genre}`;
      const [ytRes, scRes] = await Promise.allSettled([
        withTimeout(ytdlpSearchPlatform('yt', query, perPlatformLimit), Math.min(2200, maxRuntimeMs), [] as GenreHitItem[]),
        withTimeout(ytdlpSearchPlatform('sc', query, perPlatformLimit), Math.min(2200, maxRuntimeMs), [] as GenreHitItem[]),
      ]);
      return [
        ...(ytRes.status === 'fulfilled' ? ytRes.value : []),
        ...(scRes.status === 'fulfilled' ? scRes.value : []),
      ];
    }),
  );

  for (const bucket of settled) {
    if (bucket.status !== 'fulfilled') continue;
    for (const item of bucket.value) {
      const key = normalizeHitKey(item.artist, item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(item);
    }
  }

  return filterHitsByGenre(shuffleCopy(results), hints, limit);
}

export async function getTopTracksByGenre(genre: string, limit = 20, offset = 0): Promise<GenreHitItem[]> {
  const normalizedGenre = resolveMergedGenreId(genre.trim());
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const safeOffset = Math.max(0, offset);
  if (!normalizedGenre) return [];
  if (!isAllowedGenre(normalizedGenre)) return [];

  const hints = getGenreHints(normalizedGenre);
  const isFastMode = safeOffset === 0 || safeOffset <= safeLimit * 2;
  const spotifyQueries = isFastMode ? 1 : 2;
  const deezerQueries = isFastMode ? 2 : 3;
  const lastFmTags = isFastMode ? 1 : 2;
  const priorityOptions = isFastMode
    ? { artistSampleSize: 10, perPlatformLimit: 5, maxRuntimeMs: 5200 }
    : { artistSampleSize: 10, perPlatformLimit: 5, maxRuntimeMs: 5500 };
  const [spotifyRes, deezerRes, lastFmRes, priorityRes] = await Promise.allSettled([
    spotifyQueries > 0
      ? fetchSpotifyTracksByGenre(normalizedGenre, safeLimit, safeOffset, spotifyQueries)
      : Promise.resolve<GenreHitItem[]>([]),
    isFastMode
      ? withTimeout(fetchDeezerTracksByGenre(normalizedGenre, safeLimit, safeOffset, deezerQueries), 2200, [] as GenreHitItem[])
      : fetchDeezerTracksByGenre(normalizedGenre, safeLimit, safeOffset, deezerQueries),
    fetchLastFmTopTracksByGenre(normalizedGenre, safeLimit, safeOffset, lastFmTags),
    isFastMode
      ? withTimeout(fetchPriorityArtistPlatformHits(normalizedGenre, hints, safeLimit, safeOffset, priorityOptions), 2600, [] as GenreHitItem[])
      : fetchPriorityArtistPlatformHits(normalizedGenre, hints, safeLimit, safeOffset, priorityOptions),
  ]);

  const collected: GenreHitItem[] = [];
  if (spotifyRes.status === 'fulfilled') collected.push(...spotifyRes.value);
  if (deezerRes.status === 'fulfilled') collected.push(...deezerRes.value);
  if (lastFmRes.status === 'fulfilled') collected.push(...lastFmRes.value);
  if (priorityRes.status === 'fulfilled') collected.push(...priorityRes.value);

  // If curated priority artists already yield strict hits, surface them immediately.
  if (priorityRes.status === 'fulfilled' && priorityRes.value.length > 0) {
    const priorityStrict = filterHitsByGenre(priorityRes.value, hints, safeLimit);
    if (priorityStrict.length >= Math.min(3, safeLimit)) {
      const merged = dedupeHits([...priorityStrict, ...collected]).slice(0, safeLimit);
      return merged;
    }
  }

  return filterHitsByGenre(collected, hints, safeLimit);
}

export async function getPriorityArtistQuickHitsByGenre(genre: string, limit = 20): Promise<GenreHitItem[]> {
  const normalizedGenre = resolveMergedGenreId(genre.trim());
  if (!normalizedGenre) return [];
  if (!isAllowedGenre(normalizedGenre)) return [];

  const hints = getGenreHints(normalizedGenre);
  const safeLimit = Math.max(1, Math.min(limit, 30));
  const quickOptions = { artistSampleSize: 12, perPlatformLimit: 4, maxRuntimeMs: 1800 };

  return withTimeout(
    fetchPriorityArtistPlatformHits(normalizedGenre, hints, safeLimit, 0, quickOptions),
    1900,
    [] as GenreHitItem[],
  );
}
