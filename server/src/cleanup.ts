import fs from 'node:fs';
import path from 'node:path';

// Import constants from player.ts for consistent cleanup behavior
const KEEP_FILES_MAX_COUNT = Math.max(8, parseInt(process.env.KEEP_FILES_MAX_COUNT ?? '24', 10) || 24);
const KEEP_FILES_MAX_AGE_MS = Math.max(5 * 60_000, parseInt(process.env.KEEP_FILES_MAX_AGE_MS ?? String(6 * 60 * 60_000), 10) || (6 * 60 * 60_000));

export function initCache(cacheDir: string): void {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    console.log(`[cleanup] Created cache directory: ${cacheDir}`);
    return;
  }

  const now = Date.now();
  try {
    const names = fs.readdirSync(cacheDir);
    const entries = names
      .map((name) => {
        const fullPath = path.join(cacheDir, name);
        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isFile()) return null;
          return { fullPath, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { fullPath: string; mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // Sort by newest first

    let deletedCount = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const tooOld = now - entry.mtimeMs > KEEP_FILES_MAX_AGE_MS;
      const overflow = i >= KEEP_FILES_MAX_COUNT;
      if (!tooOld && !overflow) continue;

      try {
        fs.unlinkSync(entry.fullPath);
        deletedCount += 1;
      } catch {
        // ignore files that can't be deleted
      }
    }

    if (deletedCount > 0) {
      console.log(`[cleanup] Cleared ${deletedCount} stale cache file(s) on startup; keep max=${KEEP_FILES_MAX_COUNT}, age<=${Math.round(KEEP_FILES_MAX_AGE_MS / 60000)}m`);
    } else if (entries.length > 0) {
      console.log(`[cleanup] Cache directory initialized with ${entries.length} file(s); no cleanup needed`);
    }
  } catch (err) {
    console.warn('[cleanup] Cache initialization failed:', err);
  }
}

export function cleanupFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    console.warn(`[cleanup] Could not delete: ${filePath}`);
  }
}
