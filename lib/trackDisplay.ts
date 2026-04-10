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

export function decodeHtmlEntities(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function parseTrackDisplay(rawTitle: string | null | undefined): ParsedTrackDisplay {
  if (!rawTitle) return { artist: null, title: null };

  const decoded = decodeHtmlEntities(rawTitle);
  const cleaned = stripPresentationNoise(decoded);
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
