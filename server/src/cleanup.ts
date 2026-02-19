import fs from 'node:fs';
import path from 'node:path';

export function initCache(cacheDir: string): void {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    console.log(`[cleanup] Created cache directory: ${cacheDir}`);
  }

  const files = fs.readdirSync(cacheDir);
  for (const file of files) {
    try {
      fs.unlinkSync(path.join(cacheDir, file));
    } catch {
      // ignore files that can't be deleted
    }
  }

  if (files.length > 0) {
    console.log(`[cleanup] Cleared ${files.length} stale file(s) from cache`);
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
