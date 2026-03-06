import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();
const GENRE_CONFIG_PATH = path.join(__dirname, '../../config/genre-curation.json');

interface GenreConfig {
  version: number;
  genres: Genre[];
}

interface Genre {
  id: string;
  label: string;
  priorityArtists: string[];
  minScore: number;
  priorityLabels: string[];
  requiredTokens: string[];
  blockedTokens: string[];
  priorityTracks: string[];
  blockedTracks: string[];
  blockedArtists: string[];
}

function normalizeGenreId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ /g, '_');
}

// Helper function to read genre config
function readGenreConfig(): GenreConfig {
  try {
    const data = fs.readFileSync(GENRE_CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('[genre-management] Failed to read config:', err);
    throw new Error('Failed to read genre configuration');
  }
}

// Helper function to write genre config
function writeGenreConfig(config: GenreConfig): void {
  try {
    const data = JSON.stringify(config, null, 2);
    fs.writeFileSync(GENRE_CONFIG_PATH, data, 'utf8');
  } catch (err) {
    console.error('[genre-management] Failed to write config:', err);
    throw new Error('Failed to save genre configuration');
  }
}

// GET /api/genre-management/genres - Get all genres and their artists
router.get('/genre-management/genres', (_req, res) => {
  try {
    const config = readGenreConfig();
    res.json(config.genres);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/genre-management/genres - Create a new genre
router.post('/genre-management/genres', (req, res) => {
  try {
    const { id, label } = req.body ?? {};
    const rawId = typeof id === 'string' ? id : '';
    const rawLabel = typeof label === 'string' ? label : '';

    const normalizedId = normalizeGenreId(rawId || rawLabel);
    const normalizedLabel = rawLabel.trim() || normalizedId.replace(/_/g, ' ');

    if (!normalizedId) {
      return res.status(400).json({ error: 'Genre id or label is required' });
    }

    const config = readGenreConfig();
    if (!Array.isArray(config.genres)) config.genres = [];

    const alreadyExists = config.genres.some((g) => g.id.toLowerCase() === normalizedId);
    if (alreadyExists) {
      return res.status(400).json({ error: 'Genre already exists' });
    }

    const newGenre: Genre = {
      id: normalizedId,
      label: normalizedLabel,
      priorityArtists: [],
      minScore: 3,
      priorityLabels: [],
      requiredTokens: [],
      blockedTokens: [],
      priorityTracks: [],
      blockedTracks: [],
      blockedArtists: [],
    };

    config.genres.push(newGenre);
    config.genres.sort((a, b) => a.label.localeCompare(b.label));
    writeGenreConfig(config);

    console.log(`[genre-management] Created genre "${normalizedId}" (${normalizedLabel})`);
    return res.json({ success: true, genre: newGenre });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/genre-management/genres/:id - Get specific genre
router.get('/genre-management/genres/:id', (req, res) => {
  try {
    const config = readGenreConfig();
    const genre = config.genres.find(g => g.id === req.params.id);
    if (!genre) {
      return res.status(404).json({ error: 'Genre not found' });
    }
    res.json(genre);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/genre-management/genres/:id/artists - Add artist to genre
router.post('/genre-management/genres/:id/artists', (req, res) => {
  try {
    const { artist } = req.body;
    if (!artist || typeof artist !== 'string') {
      return res.status(400).json({ error: 'Artist name is required' });
    }

    const config = readGenreConfig();
    const genre = config.genres.find(g => g.id === req.params.id);
    if (!genre) {
      return res.status(404).json({ error: 'Genre not found' });
    }

    const normalizedArtist = artist.toLowerCase().trim();
    if (genre.priorityArtists.some(a => a.toLowerCase() === normalizedArtist)) {
      return res.status(400).json({ error: 'Artist already exists in this genre' });
    }

    genre.priorityArtists.push(normalizedArtist);
    genre.priorityArtists.sort();
    writeGenreConfig(config);

    console.log(`[genre-management] Added artist "${normalizedArtist}" to genre "${genre.id}"`);
    res.json({ success: true, artist: normalizedArtist });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/genre-management/genres/:id/artists/:artist - Remove artist from genre
router.delete('/genre-management/genres/:id/artists/:artist', (req, res) => {
  try {
    const config = readGenreConfig();
    const genre = config.genres.find(g => g.id === req.params.id);
    if (!genre) {
      return res.status(404).json({ error: 'Genre not found' });
    }

    const artistToRemove = decodeURIComponent(req.params.artist).toLowerCase();
    const initialLength = genre.priorityArtists.length;
    genre.priorityArtists = genre.priorityArtists.filter(a => a.toLowerCase() !== artistToRemove);

    if (genre.priorityArtists.length === initialLength) {
      return res.status(404).json({ error: 'Artist not found in this genre' });
    }

    writeGenreConfig(config);

    console.log(`[genre-management] Removed artist "${artistToRemove}" from genre "${genre.id}"`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/genre-management/genres/:id/artists/:oldArtist - Edit artist name
router.put('/genre-management/genres/:id/artists/:oldArtist', (req, res) => {
  try {
    const { newArtist } = req.body;
    if (!newArtist || typeof newArtist !== 'string') {
      return res.status(400).json({ error: 'New artist name is required' });
    }

    const config = readGenreConfig();
    const genre = config.genres.find(g => g.id === req.params.id);
    if (!genre) {
      return res.status(404).json({ error: 'Genre not found' });
    }

    const oldArtist = decodeURIComponent(req.params.oldArtist).toLowerCase();
    const normalizedNewArtist = newArtist.toLowerCase().trim();
    
    const artistIndex = genre.priorityArtists.findIndex(a => a.toLowerCase() === oldArtist);
    if (artistIndex === -1) {
      return res.status(404).json({ error: 'Artist not found in this genre' });
    }

    // Check if new artist name already exists
    if (genre.priorityArtists.some(a => a.toLowerCase() === normalizedNewArtist && a.toLowerCase() !== oldArtist)) {
      return res.status(400).json({ error: 'New artist name already exists in this genre' });
    }

    genre.priorityArtists[artistIndex] = normalizedNewArtist;
    genre.priorityArtists.sort();
    writeGenreConfig(config);

    console.log(`[genre-management] Renamed artist "${oldArtist}" to "${normalizedNewArtist}" in genre "${genre.id}"`);
    res.json({ success: true, artist: normalizedNewArtist });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/genre-management/genres/:id/blocked-tracks - Add blocked track
router.post('/genre-management/genres/:id/blocked-tracks', (req, res) => {
  try {
    const { track } = req.body;
    if (!track || typeof track !== 'string') {
      return res.status(400).json({ error: 'Track name is required' });
    }

    const config = readGenreConfig();
    const genre = config.genres.find(g => g.id === req.params.id);
    if (!genre) {
      return res.status(404).json({ error: 'Genre not found' });
    }

    const normalizedTrack = track.toLowerCase().trim();
    if (genre.blockedTracks.some(t => t.toLowerCase() === normalizedTrack)) {
      return res.status(400).json({ error: 'Track already blocked in this genre' });
    }

    genre.blockedTracks.push(normalizedTrack);
    genre.blockedTracks.sort();
    writeGenreConfig(config);

    console.log(`[genre-management] Added blocked track "${normalizedTrack}" to genre "${genre.id}"`);
    res.json({ success: true, track: normalizedTrack });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/genre-management/genres/:id/blocked-tracks/:track - Remove blocked track
router.delete('/genre-management/genres/:id/blocked-tracks/:track', (req, res) => {
  try {
    const config = readGenreConfig();
    const genre = config.genres.find(g => g.id === req.params.id);
    if (!genre) {
      return res.status(404).json({ error: 'Genre not found' });
    }

    const trackToRemove = decodeURIComponent(req.params.track).toLowerCase();
    const initialLength = genre.blockedTracks.length;
    genre.blockedTracks = genre.blockedTracks.filter(t => t.toLowerCase() !== trackToRemove);

    if (genre.blockedTracks.length === initialLength) {
      return res.status(404).json({ error: 'Blocked track not found in this genre' });
    }

    writeGenreConfig(config);

    console.log(`[genre-management] Removed blocked track "${trackToRemove}" from genre "${genre.id}"`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;