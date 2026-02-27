export type GenreConfidence = "explicit" | "artist_based" | "unknown";

export interface GenreResolutionInput {
  explicitGenre?: string | null;
  artist?: string | null;
}

export interface GenreResolution {
  genre: string | null;
  confidence: GenreConfidence;
}

const GENRE_KEYWORDS: Array<{ genre: string; keywords: string[] }> = [
  { genre: "hardstyle", keywords: ["sub zero project", "headhunterz", "wildstylez", "d-block", "s-te-fan", "ran-d", "adaro", "digital punk", "b-front", "radical redemption"] },
  { genre: "rawstyle", keywords: ["warface", "rejecta", "bloodlust", "act of rage", "e-force", "dual damage", "fraw"] },
  { genre: "uptempo", keywords: ["barber", "unproven", "lunakorpz", "drs", "spitnoise", "major conspiracy"] },
  { genre: "frenchcore", keywords: ["dr peacock", "sefa", "billx", "d-frek"] },
  { genre: "hardcore", keywords: ["angerfist", "miss k8", "mad dog", "anime", "tha playah", "outblast", "neophyte"] },
  { genre: "gabber", keywords: ["rotterdam terror corps", "paul elstak", "darkraver", "gabber"] },
  { genre: "techno", keywords: ["charlotte de witte", "amelie lens", "adam beyer", "enrico sanguiliano", "reinier zonneveld"] },
  { genre: "trance", keywords: ["armin van buuren", "ferry corsten", "above & beyond", "aly & fila", "paul van dyk"] },
  { genre: "psytrance", keywords: ["vini vici", "blastoyz", "astrix"] },
  { genre: "drum and bass", keywords: ["sub focus", "dimension", "hedex", "netsky", "chase & status", "andy c"] },
  { genre: "hiphop", keywords: ["drake", "kendrick lamar", "travis scott", "future", "lil baby"] },
  { genre: "nederlandse hiphop", keywords: ["boef", "lil kleine", "frenna", "sevn alias", "broederliefde"] },
];

export function resolveGenre(input: GenreResolutionInput): GenreResolution {
  const explicit = (input.explicitGenre ?? "").trim();
  if (explicit) {
    return { genre: explicit, confidence: "explicit" };
  }

  const artist = (input.artist ?? "").trim().toLowerCase();
  if (!artist) {
    return { genre: null, confidence: "unknown" };
  }

  for (const row of GENRE_KEYWORDS) {
    if (row.keywords.some((keyword) => artist.includes(keyword))) {
      return { genre: row.genre, confidence: "artist_based" };
    }
  }

  return { genre: null, confidence: "unknown" };
}
