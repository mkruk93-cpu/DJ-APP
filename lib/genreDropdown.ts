import type { GenreOption } from "@/lib/radioApi";

interface GenreGroupDefinition {
  id: string;
  label: string;
  children: string[];
}

export interface GenreDropdownSection {
  id: string;
  label: string;
  parent: GenreOption;
  children: GenreOption[];
}

const GENRE_GROUPS: GenreGroupDefinition[] = [
  {
    id: "hardcore",
    label: "Hardcore",
    children: [
      "krach",
      "frenchcore",
      "mainstream hardcore",
      "terror",
      "terrorcore",
      "uptempo",
      "gabber",
      "happy hardcore",
      "industrial hardcore",
    ],
  },
  {
    id: "hardstyle",
    label: "Hardstyle",
    children: ["euphoric hardstyle", "rawstyle"],
  },
  {
    id: "techno",
    label: "Techno",
    children: ["hard techno", "melodic techno"],
  },
  {
    id: "house",
    label: "House",
    children: ["deep house", "tech house", "future house", "progressive house", "electro house", "bass house"],
  },
  {
    id: "drum and bass",
    label: "Drum & Bass",
    children: ["liquid drum and bass", "neurofunk"],
  },
  {
    id: "trance",
    label: "Trance",
    children: ["psy trance", "psytrance"],
  },
  {
    id: "dubstep",
    label: "Dubstep",
    children: ["brostep"],
  },
  {
    id: "rock",
    label: "Rock",
    children: ["alternative", "alternative rock", "indie rock", "punk", "pop punk"],
  },
  {
    id: "metal",
    label: "Metal",
    children: ["heavy metal", "metalcore", "death metal"],
  },
  {
    id: "hiphop",
    label: "HipHop",
    children: ["nederlandse hiphop"],
  },
  {
    id: "pop",
    label: "Pop",
    children: ["top 40", "nederlands", "dance", "edm"],
  },
];

function normalizeGenreId(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function toTitleCase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getDefaultGenreLabel(id: string): string {
  const norm = normalizeGenreId(id);
  if (norm === "psytrance") return "Psytrance";
  if (norm === "hiphop") return "HipHop";
  if (norm === "edm") return "EDM";
  if (norm === "uk garage") return "UK Garage";
  if (norm === "drum and bass") return "Drum & Bass";
  return toTitleCase(norm);
}

const KNOWN_GENRE_IDS = new Set<string>(
  GENRE_GROUPS.flatMap((group) => [group.id, ...group.children]).map(normalizeGenreId),
);

export const GENRE_FALLBACK_OPTIONS: GenreOption[] = Array.from(KNOWN_GENRE_IDS)
  .sort((a, b) => a.localeCompare(b, "nl", { sensitivity: "base" }))
  .map((id) => ({ id, name: getDefaultGenreLabel(id) }));

export function isGroupedParentGenre(genre: string): boolean {
  const norm = normalizeGenreId(genre);
  return GENRE_GROUPS.some((group) => group.id === norm);
}

export function getGenreGroupMembers(genre: string): string[] {
  const norm = normalizeGenreId(genre);
  const group = GENRE_GROUPS.find((entry) => entry.id === norm);
  if (!group) return [norm];
  return [group.id, ...group.children];
}

export function resolveGenreLabel(genre: string | null, options: GenreOption[]): string {
  if (!genre) return "Genre selecteren";
  const norm = normalizeGenreId(genre);
  const fromOptions = options.find((item) => normalizeGenreId(item.id) === norm || normalizeGenreId(item.name) === norm);
  if (fromOptions?.name) return fromOptions.name;
  const grouped = GENRE_GROUPS.find((group) => group.id === norm);
  if (grouped) return `${grouped.label} (alles)`;
  return getDefaultGenreLabel(norm);
}

export function buildGroupedGenreSections(
  options: GenreOption[],
  query: string,
): GenreDropdownSection[] {
  const normQuery = normalizeGenreId(query);
  const optionMap = new Map<string, GenreOption>();
  for (const option of options) {
    const id = normalizeGenreId(option.id || option.name);
    if (!id) continue;
    optionMap.set(id, { id, name: option.name || getDefaultGenreLabel(id) });
  }
  for (const fallback of GENRE_FALLBACK_OPTIONS) {
    const id = normalizeGenreId(fallback.id);
    if (!optionMap.has(id)) optionMap.set(id, fallback);
  }

  const matches = (value: string): boolean => !normQuery || normalizeGenreId(value).includes(normQuery);

  const sections: GenreDropdownSection[] = [];
  const covered = new Set<string>();

  for (const group of GENRE_GROUPS) {
    const parent = optionMap.get(group.id) ?? { id: group.id, name: `${group.label} (alles)` };
    const parentDisplay: GenreOption = {
      id: group.id,
      name: parent.name || `${group.label} (alles)`,
    };
    const childOptions = group.children
      .map((childId) => optionMap.get(childId) ?? { id: childId, name: getDefaultGenreLabel(childId) })
      .filter((child) => matches(child.name) || matches(child.id) || matches(group.label));

    const includeParent = matches(parentDisplay.name) || matches(parentDisplay.id) || childOptions.length > 0;
    if (!includeParent) continue;

    sections.push({
      id: group.id,
      label: group.label,
      parent: { id: group.id, name: `${group.label} (alles)` },
      children: childOptions,
    });
    covered.add(group.id);
    for (const child of group.children) covered.add(child);
  }

  const miscOptions = Array.from(optionMap.values())
    .filter((option) => !covered.has(option.id))
    .filter((option) => matches(option.name) || matches(option.id))
    .sort((a, b) => a.name.localeCompare(b.name, "nl", { sensitivity: "base" }));

  if (miscOptions.length > 0) {
    sections.push({
      id: "other",
      label: "Overig",
      parent: { id: "other", name: "Overig" },
      children: miscOptions,
    });
  }

  return sections;
}
