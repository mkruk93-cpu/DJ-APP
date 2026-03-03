import https from 'node:https';

export function fetchArtwork(artist: string, title: string): Promise<string | null> {
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
          const artUrl: string = results[0]?.artworkUrl100 ?? '';
          resolve(artUrl ? artUrl.replace('100x100bb', '600x600bb') : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
