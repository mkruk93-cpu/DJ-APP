import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Server as IOServer } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import { initCache } from './cleanup.js';
import { seedSettings, getActiveMode, getModeSettings, getSetting, setSetting } from './settings.js';
import { getQueue, addToQueue, removeFromQueue, reorderQueue, fetchVideoInfo, extractYoutubeId, getThumbnailUrl } from './queue.js';
import { canPerformAction } from './permissions.js';
import { startPlayCycle, getCurrentTrack, skipCurrentTrack, playerEvents, setKeepFiles, invalidatePreload } from './player.js';
import { startBridge } from './bridge.js';
import { startNowPlayingWatcher } from './nowPlaying.js';
import type { Mode, ServerState, DurationVote } from './types.js';

// ── Environment ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const CACHE_DIR = process.env.CACHE_DIR ?? 'C:/temp/radio_cache';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000';

const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH ?? '';
const REKORDBOX_OUTPUT_PATH = process.env.REKORDBOX_OUTPUT_PATH ?? '';
const KEEP_FILES = process.env.KEEP_FILES === 'true';

const ICECAST = {
  host: process.env.ICECAST_HOST ?? 'localhost',
  port: parseInt(process.env.ICECAST_PORT ?? '8000', 10),
  password: process.env.ICECAST_PASSWORD ?? '',
  mount: process.env.ICECAST_MOUNT ?? '/stream',
};

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Express + Socket.io ──────────────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);

const io = new IOServer(httpServer, {
  cors: {
    origin: (_origin, callback) => callback(null, true),
    methods: ['GET', 'POST'],
  },
});

app.use((_req, res, next) => {
  const origin = _req.headers.origin ?? '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});
app.use(express.json());

// ── Helpers ──────────────────────────────────────────────────────────────────

function isAdmin(token?: string): boolean {
  return !!token && token === ADMIN_TOKEN;
}

const startTime = Date.now();

async function getServerState(): Promise<ServerState> {
  const [mode, modeSettings, queue] = await Promise.all([
    getActiveMode(sb),
    getModeSettings(sb),
    getQueue(sb),
  ]);

  return {
    currentTrack: getCurrentTrack(),
    queue,
    mode,
    modeSettings,
    listenerCount: io.engine.clientsCount,
    streamOnline: getCurrentTrack() !== null,
    voteState: null,
    durationVote: activeDurationVote,
  };
}

// ── YouTube Search ──────────────────────────────────────────────────────────

interface SearchResult {
  id: string;
  title: string;
  url: string;
  duration: number | null;
  thumbnail: string;
  channel: string;
}

function youtubeSearch(query: string, limit = 6): Promise<SearchResult[]> {
  return new Promise((resolve) => {
    const proc = spawn('python', [
      '-m', 'yt_dlp',
      `ytsearch${limit}:${query}`,
      '--flat-playlist',
      '-j',
      '--no-warnings',
    ], { timeout: 15_000 });

    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on('data', () => {});

    proc.on('close', (code) => {
      if (code !== 0) { resolve([]); return; }

      const results: SearchResult[] = [];
      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          results.push({
            id: item.id,
            title: item.title ?? 'Onbekend',
            url: item.url ?? `https://www.youtube.com/watch?v=${item.id}`,
            duration: typeof item.duration === 'number' ? Math.round(item.duration) : null,
            thumbnail: `https://img.youtube.com/vi/${item.id}/mqdefault.jpg`,
            channel: item.channel ?? item.uploader ?? '',
          });
        } catch {}
      }
      resolve(results);
    });

    proc.on('error', () => resolve([]));
  });
}

// ── REST Endpoints ───────────────────────────────────────────────────────────

app.get('/state', async (_req, res) => {
  try {
    const state = await getServerState();
    console.log(`[rest] /state → track: ${state.currentTrack?.title ?? 'none'}, queue: ${state.queue.length}, mode: ${state.mode}`);
    res.json(state);
  } catch (err) {
    console.error('[rest] /state error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    listeners: io.engine.clientsCount,
  });
});

app.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q || q.length < 2) {
    res.json([]);
    return;
  }

  try {
    const results = await youtubeSearch(q);
    res.json(results);
  } catch (err) {
    console.error('[rest] /search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Proxy Icecast stream so everything runs through one port
app.get('/listen', (req, res) => {
  const icecastStreamUrl = `http://${ICECAST.host}:${ICECAST.port}${ICECAST.mount}`;

  const proxyReq = http.get(icecastStreamUrl, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 200, {
      'Content-Type': proxyRes.headers['content-type'] ?? 'audio/mpeg',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Icecast stream not available' });
    }
  });

  req.on('close', () => proxyReq.destroy());
});

// ── Admin REST endpoints (reliable through tunnels) ─────────────────────────

app.post('/api/mode', async (req, res) => {
  const { mode, token } = req.body ?? {};
  if (!isAdmin(token)) return res.status(403).json({ error: 'Unauthorized' });

  const validModes = ['dj', 'radio', 'democracy', 'jukebox', 'party'];
  if (!validModes.includes(mode)) return res.status(400).json({ error: 'Invalid mode' });

  try {
    await setSetting(sb, 'active_mode', mode);
    resetVotes();
    const modeSettings = await getModeSettings(sb);
    io.emit('mode:change', { mode: mode as Mode, settings: modeSettings });
    console.log(`[rest] Mode changed to: ${mode}`);
    res.json({ ok: true, mode });
  } catch (err) {
    console.error('[rest] mode error:', err);
    res.status(500).json({ error: 'Failed to set mode' });
  }
});

app.post('/api/settings', async (req, res) => {
  const { key, value, token } = req.body ?? {};
  if (!isAdmin(token)) return res.status(403).json({ error: 'Unauthorized' });

  try {
    await setSetting(sb, key, value);
    const modeSettings = await getModeSettings(sb);
    const mode = await getActiveMode(sb);
    io.emit('mode:change', { mode, settings: modeSettings });
    console.log(`[rest] Setting updated: ${key}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[rest] settings error:', err);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

app.post('/api/skip', async (req, res) => {
  const { token } = req.body ?? {};
  if (!isAdmin(token)) return res.status(403).json({ error: 'Unauthorized' });

  skipCurrentTrack();
  console.log('[rest] Track skipped by admin');
  res.json({ ok: true });
});

app.post('/api/keep-files', async (req, res) => {
  const { keep, token } = req.body ?? {};
  if (!isAdmin(token)) return res.status(403).json({ error: 'Unauthorized' });

  setKeepFiles(!!keep);
  io.emit('settings:keepFilesChanged', { keep: !!keep });
  console.log(`[rest] Keep files: ${keep}`);
  res.json({ ok: true, keep: !!keep });
});

// ── Vote skip state ──────────────────────────────────────────────────────────

let voteSkipSet = new Set<string>();
let voteTimer: ReturnType<typeof setTimeout> | null = null;

function resetVotes(): void {
  voteSkipSet.clear();
  if (voteTimer) {
    clearTimeout(voteTimer);
    voteTimer = null;
  }
}

// ── Duration vote state ─────────────────────────────────────────────────────

const MAX_DURATION = 600;
const VOTE_THRESHOLD = 300;
const DURATION_VOTE_TIMEOUT = 30_000;

let activeDurationVote: DurationVote | null = null;
let durationVoteTimer: ReturnType<typeof setTimeout> | null = null;

function broadcastDurationVote(): void {
  if (activeDurationVote) {
    io.emit('durationVote:update', activeDurationVote);
  } else {
    io.emit('durationVote:end', null);
  }
}

function finalizeDurationVote(): void {
  if (!activeDurationVote) return;
  const vote = activeDurationVote;

  if (durationVoteTimer) {
    clearTimeout(durationVoteTimer);
    durationVoteTimer = null;
  }

  const accepted = vote.yes > vote.no;
  console.log(`[duration-vote] Result: ${vote.yes} ja / ${vote.no} nee → ${accepted ? 'GEACCEPTEERD' : 'GEWEIGERD'}`);

  if (accepted) {
    addToQueue(sb, vote.youtube_url, vote.added_by)
      .then(async (item) => {
        const queue = await getQueue(sb);
        io.emit('queue:update', { items: queue });
        playerEvents.emit('queue:add');
        console.log(`[queue] Added after vote: ${item.youtube_id} by ${vote.added_by}`);
      })
      .catch((err) => {
        console.error('[duration-vote] Failed to add after vote:', err);
      });
    io.emit('durationVote:result', { accepted: true, title: vote.title });
  } else {
    io.emit('durationVote:result', { accepted: false, title: vote.title });
  }

  activeDurationVote = null;
  broadcastDurationVote();
}

function startDurationVote(
  youtubeUrl: string,
  title: string | null,
  thumbnail: string | null,
  duration: number,
  addedBy: string,
): void {
  // Cancel any existing vote
  if (activeDurationVote) {
    activeDurationVote = null;
    if (durationVoteTimer) {
      clearTimeout(durationVoteTimer);
      durationVoteTimer = null;
    }
  }

  activeDurationVote = {
    id: `dv_${Date.now()}`,
    youtube_url: youtubeUrl,
    title,
    thumbnail,
    duration,
    added_by: addedBy,
    yes: 0,
    no: 0,
    voters: [],
    expires_at: Date.now() + DURATION_VOTE_TIMEOUT,
  };

  console.log(`[duration-vote] Started for "${title}" (${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')})`);
  broadcastDurationVote();

  durationVoteTimer = setTimeout(() => {
    console.log('[duration-vote] Timer expired');
    finalizeDurationVote();
  }, DURATION_VOTE_TIMEOUT);
}

// ── Socket.io Events ─────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[socket] Client connected: ${socket.id}`);
  io.emit('stream:status', { online: getCurrentTrack() !== null, listeners: io.engine.clientsCount });

  // ── auth:verify ──
  socket.on('auth:verify', (data: { token: string }, callback?: (valid: boolean) => void) => {
    const valid = isAdmin(data.token);
    if (typeof callback === 'function') callback(valid);
  });

  // ── queue:add ──
  socket.on('queue:add', async (data: { youtube_url: string; added_by: string; token?: string }) => {
    try {
      const mode = await getActiveMode(sb);
      const admin = isAdmin(data.token);
      if (!canPerformAction(mode, 'add_to_queue', admin)) {
        socket.emit('error:toast', { message: 'Je mag geen nummers toevoegen in deze modus' });
        return;
      }

      socket.emit('info:toast', { message: 'Even checken...' });

      const youtubeId = extractYoutubeId(data.youtube_url);
      const thumbnail = youtubeId ? getThumbnailUrl(youtubeId) : null;

      const info = await fetchVideoInfo(data.youtube_url);

      if (info.duration !== null && info.duration > MAX_DURATION) {
        socket.emit('error:toast', {
          message: `Dit nummer is te lang (${Math.floor(info.duration / 60)}:${String(Math.round(info.duration % 60)).padStart(2, '0')}). Maximum is 10 minuten.`,
        });
        return;
      }

      if (info.duration !== null && info.duration > VOTE_THRESHOLD && !admin) {
        const mins = Math.floor(info.duration / 60);
        const secs = String(Math.round(info.duration % 60)).padStart(2, '0');
        socket.emit('info:toast', {
          message: `Nummer is ${mins}:${secs} — er wordt gestemd!`,
        });
        startDurationVote(data.youtube_url, info.title, thumbnail, info.duration, data.added_by || 'anonymous');
        return;
      }

      const item = await addToQueue(sb, data.youtube_url, data.added_by || 'anonymous', info.title);
      const queue = await getQueue(sb);
      io.emit('queue:update', { items: queue });
      playerEvents.emit('queue:add');
      console.log(`[queue] Added: ${item.youtube_id} by ${data.added_by}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Kon nummer niet toevoegen';
      socket.emit('error:toast', { message: msg });
    }
  });

  // ── durationVote:cast ──
  socket.on('durationVote:cast', (data: { vote: 'yes' | 'no' }) => {
    if (!activeDurationVote) {
      socket.emit('error:toast', { message: 'Geen actieve stemming' });
      return;
    }

    if (activeDurationVote.voters.includes(socket.id)) {
      socket.emit('error:toast', { message: 'Je hebt al gestemd' });
      return;
    }

    activeDurationVote.voters.push(socket.id);
    if (data.vote === 'yes') {
      activeDurationVote.yes++;
    } else {
      activeDurationVote.no++;
    }

    console.log(`[duration-vote] ${socket.id} voted ${data.vote} (${activeDurationVote.yes}/${activeDurationVote.no})`);
    broadcastDurationVote();

    // Check if all connected clients have voted
    const totalClients = io.engine.clientsCount;
    if (activeDurationVote.voters.length >= totalClients) {
      finalizeDurationVote();
    }
  });

  // ── track:skip ──
  socket.on('track:skip', async (data: { isAdmin?: boolean; token?: string }) => {
    try {
      const mode = await getActiveMode(sb);
      const admin = isAdmin(data.token);

      if (!canPerformAction(mode, 'skip', admin)) {
        socket.emit('error:toast', { message: 'Je mag niet skippen in deze modus' });
        return;
      }

      const queue = await getQueue(sb);
      const track = getCurrentTrack();
      const nextItems = track ? queue.filter((q) => q.id !== track.id) : queue;
      if (nextItems.length === 0) {
        socket.emit('error:toast', { message: 'Kan niet skippen — geen volgend nummer in de wachtrij' });
        return;
      }

      console.log(`[player] Skip requested by ${admin ? 'admin' : socket.id}`);
      resetVotes();
      skipCurrentTrack();
    } catch (err) {
      console.error('[socket] track:skip error:', err);
    }
  });

  // ── vote:skip ──
  socket.on('vote:skip', async () => {
    try {
      const mode = await getActiveMode(sb);
      if (!canPerformAction(mode, 'vote_skip', false)) {
        socket.emit('error:toast', { message: 'Stemmen is niet beschikbaar in deze modus' });
        return;
      }

      voteSkipSet.add(socket.id);
      const settings = await getModeSettings(sb);
      const threshold = settings.democracy_threshold / 100;
      const required = Math.max(1, Math.ceil(io.engine.clientsCount * threshold));
      const timerSeconds = settings.democracy_timer;

      // Start timer on first vote
      if (voteSkipSet.size === 1 && !voteTimer) {
        voteTimer = setTimeout(() => {
          console.log('[vote] Timer expired — votes reset');
          resetVotes();
          io.emit('vote:update', { votes: 0, required, timer: 0 });
        }, timerSeconds * 1000);
      }

      io.emit('vote:update', {
        votes: voteSkipSet.size,
        required,
        timer: timerSeconds,
      });

      if (voteSkipSet.size >= required) {
        const queue = await getQueue(sb);
        const track = getCurrentTrack();
        const nextItems = track ? queue.filter((q) => q.id !== track.id) : queue;
        if (nextItems.length === 0) {
          io.emit('error:toast', { message: 'Kan niet skippen — geen volgend nummer in de wachtrij' });
          resetVotes();
        } else {
          console.log('[vote] Threshold reached — skipping');
          resetVotes();
          skipCurrentTrack();
        }
      }
    } catch (err) {
      console.error('[socket] vote:skip error:', err);
    }
  });

  // ── mode:set ──
  socket.on('mode:set', async (data: { mode: string; token: string }) => {
    if (!isAdmin(data.token)) {
      socket.emit('error:toast', { message: 'Geen admin rechten' });
      return;
    }

    const validModes = ['dj', 'radio', 'democracy', 'jukebox', 'party'];
    if (!validModes.includes(data.mode)) {
      socket.emit('error:toast', { message: 'Ongeldige modus' });
      return;
    }

    try {
      await setSetting(sb, 'active_mode', data.mode);
      resetVotes();
      const modeSettings = await getModeSettings(sb);
      io.emit('mode:change', { mode: data.mode as Mode, settings: modeSettings });
      console.log(`[mode] Changed to: ${data.mode}`);
    } catch (err) {
      console.error('[socket] mode:set error:', err);
    }
  });

  // ── settings:update ──
  socket.on('settings:update', async (data: { key: string; value: unknown; token: string }) => {
    if (!isAdmin(data.token)) {
      socket.emit('error:toast', { message: 'Geen admin rechten' });
      return;
    }

    try {
      await setSetting(sb, data.key, data.value);
      const modeSettings = await getModeSettings(sb);
      const mode = await getActiveMode(sb);
      io.emit('mode:change', { mode, settings: modeSettings });
      console.log(`[settings] Updated: ${data.key}`);
    } catch (err) {
      console.error('[socket] settings:update error:', err);
    }
  });

  // ── queue:reorder ──
  socket.on('queue:reorder', async (data: { id: string; newPosition: number; token: string }) => {
    if (!isAdmin(data.token)) {
      socket.emit('error:toast', { message: 'Geen admin rechten' });
      return;
    }

    try {
      await reorderQueue(sb, data.id, data.newPosition);
      invalidatePreload();
      const queue = await getQueue(sb);
      io.emit('queue:update', { items: queue });
      console.log(`[queue] Reordered: ${data.id} → position ${data.newPosition}`);
    } catch (err) {
      console.error('[socket] queue:reorder error:', err);
    }
  });

  // ── queue:remove ──
  socket.on('queue:remove', async (data: { id: string; token: string }) => {
    if (!isAdmin(data.token)) {
      socket.emit('error:toast', { message: 'Geen admin rechten' });
      return;
    }

    try {
      await removeFromQueue(sb, data.id);
      invalidatePreload();
      const queue = await getQueue(sb);
      io.emit('queue:update', { items: queue });
      console.log(`[queue] Removed: ${data.id}`);
    } catch (err) {
      console.error('[socket] queue:remove error:', err);
    }
  });

  // ── settings:keepFiles ──
  socket.on('settings:keepFiles', (data: { keep: boolean; token: string }) => {
    if (!isAdmin(data.token)) {
      socket.emit('error:toast', { message: 'Geen admin rechten' });
      return;
    }
    setKeepFiles(data.keep);
    io.emit('settings:keepFilesChanged', { keep: data.keep });
    console.log(`[settings] Keep files: ${data.keep}`);
  });

  // ── disconnect ──
  socket.on('disconnect', () => {
    voteSkipSet.delete(socket.id);
    io.emit('stream:status', { online: getCurrentTrack() !== null, listeners: io.engine.clientsCount });
  });
});

// ── Startup ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[server] Starting radio control server...');

  // Initialize cache
  initCache(CACHE_DIR);

  // Seed default settings
  await seedSettings(sb);
  console.log('[server] Settings seeded');

  // Start HTTP server
  httpServer.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
    console.log(`[server] CORS allowed: ${FRONTEND_URL}`);
    console.log(`[server] Icecast target: ${ICECAST.host}:${ICECAST.port}${ICECAST.mount}`);
  });

  // Apply keep-files setting
  setKeepFiles(KEEP_FILES);
  console.log(`[server] Keep files after streaming: ${KEEP_FILES}`);

  // Start the play cycle
  startPlayCycle(sb, io, CACHE_DIR, ICECAST);

  // Start the bridge (downloads approved requests)
  startBridge(sb, DOWNLOAD_PATH);

  // Start now-playing watcher (RekordBox output files)
  startNowPlayingWatcher(sb, REKORDBOX_OUTPUT_PATH);
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
