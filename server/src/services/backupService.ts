import fs from 'node:fs';
import { join, dirname } from 'node:path';
import AdmZip from 'adm-zip';

const BACKUP_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 uur
const MAX_BACKUPS = 14; // Bewaar 7 dagen (2 per dag)
const DATA_DIR = join(process.cwd(), 'data');
const BACKUP_DIR = join(process.cwd(), 'backups');

export function startBackupService(): void {
  console.log('[backup] Service gestart. Volgende backup over 12 uur.');
  
  // Voer de eerste backup direct uit bij opstarten (veiligheidsmaatregel)
  performBackup().catch(err => {
    console.error('[backup] Eerste backup mislukt:', err);
  });

  // Plan de volgende backups in
  setInterval(() => {
    performBackup().catch(err => {
      console.error('[backup] Periodieke backup mislukt:', err);
    });
  }, BACKUP_INTERVAL_MS);
}

async function performBackup(): Promise<void> {
  if (!fs.existsSync(DATA_DIR)) {
    console.warn('[backup] Data map niet gevonden op:', DATA_DIR);
    return;
  }

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zipFile = join(BACKUP_DIR, `data-backup-${timestamp}.zip`);

  console.log(`[backup] Bezig met maken van backup: ${zipFile}...`);

  try {
    const zip = new AdmZip();
    zip.addLocalFolder(DATA_DIR);
    await zip.writeZipPromise(zipFile);
    
    console.log(`[backup] Backup succesvol opgeslagen (${zipFile})`);
    
    // Ruim oude backups op
    cleanupOldBackups();
  } catch (err) {
    throw new Error(`Zip creatie mislukt: ${(err as Error).message}`);
  }
}

function cleanupOldBackups(): void {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('data-backup-') && f.endsWith('.zip'))
      .map(f => ({
        name: f,
        path: join(BACKUP_DIR, f),
        mtime: fs.statSync(join(BACKUP_DIR, f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime); // Nieuwste bovenaan

    if (files.length > MAX_BACKUPS) {
      const toDelete = files.slice(MAX_BACKUPS);
      for (const file of toDelete) {
        fs.unlinkSync(file.path);
        console.log(`[backup] Oude backup verwijderd: ${file.name}`);
      }
    }
  } catch (err) {
    console.error('[backup] Fout bij opruimen oude backups:', err);
  }
}
