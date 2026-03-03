import https from 'node:https';

export interface ArtworkCandidate {
  artworkUrl: string;
  artistName: string | null;
  trackName: string | null;
}

export function fetchArtworkCandidate(artist: string, title: string): Promise<ArtworkCandidate | null> {
  const query = `${artist} ${title}`.trim();
  if (!query) return Promise.resolve(null);

  const url = `https://itunes.apple.com/search?${new URLSearchParams({
    term: query,
    media: 'music',
    limit: '1',
  })}`;

  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 5_000 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const results = data?.results ?? [];
          if (results.length === 0) { resolve(null); return; }
          const first = results[0] ?? {};
          const artUrl: string = first?.artworkUrl100 ?? '';
          if (!artUrl) { resolve(null); return; }
          resolve({
            artworkUrl: artUrl.replace('100x100bb', '600x600bb'),
            artistName: typeof first?.artistName === 'string' ? first.artistName : null,
            trackName: typeof first?.trackName === 'string' ? first.trackName : null,
          });
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

export function fetchArtwork(artist: string, title: string): Promise<string | null> {
  return fetchArtworkCandidate(artist, title).then((candidate) => candidate?.artworkUrl ?? null);
}
