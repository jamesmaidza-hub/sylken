import { defaultBackupDir, defaultPgBin, runBackup, type BackupSettings } from '../backup/backup.js'
import { parseKey } from '../backup/crypto.js'

/** Settings for backups and restores, from the environment (the .env file). Shared by the backup and restore commands. */
export function backupSettings(): BackupSettings {
  const adminUrl = process.env.DATABASE_ADMIN_URL
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is not set')
  return {
    adminUrl,
    pgBin: defaultPgBin(),
    dir: defaultBackupDir(),
    copyDir: process.env.SYLKEN_BACKUP_COPY_DIR || null,
    key: parseKey(process.env.SYLKEN_BACKUP_KEY),
  }
}

// npm run backup: one encrypted backup of the database now. The scheduled task runs this every night.
try {
  const s = backupSettings()
  const meta = await runBackup(s)
  console.log(`backup ${meta.file}: ${(meta.bytes / 1024 / 1024).toFixed(1)} MB, ${meta.counts.items} items, ${meta.counts.patients} patients, ${meta.counts.sales} sales`)
  console.log(`kept in ${s.dir}`)
  if (!s.copyDir) console.log('WARNING: no second copy. Set SYLKEN_BACKUP_COPY_DIR to a USB drive or a synced folder so a backup survives this computer.')
  else console.log(meta.copied ? `copied to ${s.copyDir}` : `WARNING: the copy to ${s.copyDir} failed: ${meta.copyError}`)
} catch (e) {
  console.error('BACKUP FAILED:', (e as Error).message)
  process.exit(1)
}
