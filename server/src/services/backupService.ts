import fs from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import AdmZip from 'adm-zip';

const BACKUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
const STARTUP_BACKUP_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const KEEP_ALL_FOR_DAYS = 7;
const KEEP_DAILY_FOR_DAYS = 30;
const KEEP_WEEKLY_FOR_DAYS = 180;
const MAX_TOTAL_BACKUPS = 120;

type BackupEntry = {
  name: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
};

function resolvePaths(): { appRoot: string; dataDir: string; backupDir: string } {
  const cwd = process.cwd();
  const runningFromServerRoot =
    fs.existsSync(join(cwd, 'src')) &&
    fs.existsSync(join(cwd, 'data')) &&
    fs.existsSync(join(cwd, 'package.json'));

  const appRoot = runningFromServerRoot ? resolve(cwd, '..') : cwd;
  const dataDir = runningFromServerRoot ? join(cwd, 'data') : join(appRoot, 'server', 'data');
  const backupDir = join(appRoot, 'backups', 'server-data');

  return { appRoot, dataDir, backupDir };
}

function listBackupEntries(backupDir: string): BackupEntry[] {
  if (!fs.existsSync(backupDir)) return [];

  return fs.readdirSync(backupDir)
    .filter((name) => name.startsWith('server-data-backup-') && name.endsWith('.zip'))
    .map((name) => {
      const filePath = join(backupDir, name);
      const stats = fs.statSync(filePath);
      return {
        name,
        path: filePath,
        mtimeMs: stats.mtimeMs,
        sizeBytes: stats.size,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function walkJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const results: string[] = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (/\.jsonl?$/i.test(entry.name)) {
        results.push(fullPath);
      }
    }
  }

  return results.sort();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function isoWeekKey(date: Date): string {
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utcDate.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utcDate.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function pruneBackups(backupDir: string): void {
  const entries = listBackupEntries(backupDir);
  if (entries.length === 0) return;

  const now = Date.now();
  const keep = new Set<string>();
  const dailyBuckets = new Set<string>();
  const weeklyBuckets = new Set<string>();

  for (const entry of entries) {
    const ageDays = (now - entry.mtimeMs) / 86400000;
    const date = new Date(entry.mtimeMs);
    const dayKey = date.toISOString().slice(0, 10);
    const weekKey = isoWeekKey(date);

    if (ageDays <= KEEP_ALL_FOR_DAYS) {
      keep.add(entry.path);
      continue;
    }

    if (ageDays <= KEEP_DAILY_FOR_DAYS) {
      if (!dailyBuckets.has(dayKey)) {
        dailyBuckets.add(dayKey);
        keep.add(entry.path);
      }
      continue;
    }

    if (ageDays <= KEEP_WEEKLY_FOR_DAYS) {
      if (!weeklyBuckets.has(weekKey)) {
        weeklyBuckets.add(weekKey);
        keep.add(entry.path);
      }
      continue;
    }
  }

  const keptSorted = entries.filter((entry) => keep.has(entry.path));
  if (keptSorted.length > MAX_TOTAL_BACKUPS) {
    for (const overflowEntry of keptSorted.slice(MAX_TOTAL_BACKUPS)) {
      keep.delete(overflowEntry.path);
    }
  }

  for (const entry of entries) {
    if (keep.has(entry.path)) continue;
    try {
      fs.unlinkSync(entry.path);
      console.log(`[backup] Oude backup verwijderd: ${entry.name}`);
    } catch (err) {
      console.warn(`[backup] Kon oude backup niet verwijderen (${entry.name}): ${(err as Error).message}`);
    }
  }
}

let backupInProgress = false;

async function createBackup(reason: 'startup' | 'scheduled'): Promise<void> {
  if (backupInProgress) {
    console.log(`[backup] Backup overgeslagen (${reason}); er draait al een backup.`);
    return;
  }

  const { appRoot, dataDir, backupDir } = resolvePaths();
  if (!fs.existsSync(dataDir)) {
    console.warn(`[backup] Data map niet gevonden: ${dataDir}`);
    return;
  }

  const files = walkJsonFiles(dataDir);
  if (files.length === 0) {
    console.warn(`[backup] Geen JSON bestanden gevonden in ${dataDir}`);
    return;
  }

  fs.mkdirSync(backupDir, { recursive: true });
  backupInProgress = true;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zipPath = join(backupDir, `server-data-backup-${timestamp}.zip`);
  const zip = new AdmZip();

  try {
    let totalBytes = 0;

    for (const filePath of files) {
      const stats = fs.statSync(filePath);
      totalBytes += stats.size;
      const archivePath = `server-data/${relative(dataDir, filePath).replace(/\\/g, '/')}`;
      zip.addLocalFile(filePath, dirname(archivePath).replace(/\\/g, '/'), basename(archivePath));
    }

    zip.addFile(
      'backup-manifest.json',
      Buffer.from(JSON.stringify({
        created_at: new Date().toISOString(),
        reason,
        source_dir: relative(appRoot, dataDir).replace(/\\/g, '/'),
        file_count: files.length,
        total_bytes: totalBytes,
        files: files.map((filePath) => {
          const stats = fs.statSync(filePath);
          return {
            path: relative(appRoot, filePath).replace(/\\/g, '/'),
            size_bytes: stats.size,
            modified_at: new Date(stats.mtimeMs).toISOString(),
          };
        }),
      }, null, 2), 'utf8'),
    );

    await zip.writeZipPromise(zipPath);
    console.log(`[backup] Backup opgeslagen: ${zipPath} (${files.length} bestanden, ${formatBytes(totalBytes)})`);
    pruneBackups(backupDir);
  } catch (err) {
    console.error(`[backup] Backup mislukt (${reason}): ${(err as Error).message}`);
    try {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    } catch {}
  } finally {
    backupInProgress = false;
  }
}

async function runStartupBackupIfNeeded(): Promise<void> {
  const { backupDir } = resolvePaths();
  const latest = listBackupEntries(backupDir)[0];

  if (!latest) {
    await createBackup('startup');
    return;
  }

  const ageMs = Date.now() - latest.mtimeMs;
  if (ageMs > STARTUP_BACKUP_MAX_AGE_MS) {
    await createBackup('startup');
    return;
  }

  console.log(`[backup] Laatste backup is recent genoeg (${Math.round(ageMs / 60000)} min geleden), startup backup overgeslagen.`);
}

export function startBackupService(): void {
  const { dataDir, backupDir } = resolvePaths();
  console.log(`[backup] Service gestart. Bron: ${dataDir}`);
  console.log(`[backup] Backupmap: ${backupDir}`);
  console.log('[backup] Schema: elke 12 uur, retentie = 7 dagen volledig, daarna dagelijks tot 30 dagen, daarna wekelijks tot 180 dagen.');

  void runStartupBackupIfNeeded();

  const timer = setInterval(() => {
    void createBackup('scheduled');
  }, BACKUP_INTERVAL_MS);

  timer.unref?.();
}
