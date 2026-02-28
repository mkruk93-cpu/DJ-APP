export interface ParsedTrackDisplay {
  artist: string | null;
  title: string | null;
}

const SEPARATORS = [" - ", " – ", " — ", " | ", ": "];
const STRIP_SUFFIX_PATTERNS = [
  /\s+\((official|lyrics?|audio|video|hq|hd)[^)]*\)\s*$/i,
  /\s+\[(official|lyrics?|audio|video|hq|hd)[^\]]*\]\s*$/i,
];

function normalize(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function stripPresentationNoise(input: string): string {
  let next = input;
  for (const pattern of STRIP_SUFFIX_PATTERNS) {
    next = next.replace(pattern, "");
  }
  return normalize(next);
}

export function parseTrackDisplay(rawTitle: string | null | undefined): ParsedTrackDisplay {
  if (!rawTitle) return { artist: null, title: null };

  const cleaned = stripPresentationNoise(rawTitle);
  if (!cleaned) return { artist: null, title: null };

  for (const separator of SEPARATORS) {
    const idx = cleaned.indexOf(separator);
    if (idx <= 0 || idx >= cleaned.length - separator.length) continue;

    const left = normalize(cleaned.slice(0, idx));
    const right = normalize(cleaned.slice(idx + separator.length));

    if (!left || !right) continue;
    if (left.length > 80 || right.length > 180) continue;

    return { artist: left, title: right };
  }

  return { artist: null, title: cleaned };
}
