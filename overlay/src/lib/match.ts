function norm(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesNowPlaying(
  nowPlaying: { title: string | null; artist: string | null },
  request: { title: string | null; artist: string | null; url: string },
): boolean {
  if (!nowPlaying.title && !nowPlaying.artist) return false;
  const npTitle = norm(nowPlaying.title ?? "");
  const npArtist = norm(nowPlaying.artist ?? "");
  const reqTitle = norm(request.title ?? "");
  const reqArtist = norm(request.artist ?? "");
  const reqUrl = norm(request.url);

  const titleHit =
    !!npTitle &&
    (reqTitle.includes(npTitle) || npTitle.includes(reqTitle) || reqUrl.includes(npTitle));

  const artistHit =
    !!npArtist &&
    (reqArtist.includes(npArtist) || npArtist.includes(reqArtist) || reqUrl.includes(npArtist));

  if (titleHit && artistHit) return true;
  if (titleHit && !npArtist) return true;
  if (artistHit && !npTitle) return true;
  return false;
}
