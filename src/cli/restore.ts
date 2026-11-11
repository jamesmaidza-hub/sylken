import { latestBackup, restoreInto, verifyBackup, defaultBackupDir, defaultPgBin, type BackupSettings } from '../backup/backup.js'
import { parseKey } from '../backup/crypto.js'
import { args } from './args.js'

// npm run backup:verify               restore the newest backup into a temporary database, check it, remove it
// npm run restore -- --to sylken_restored [--file <backup>]   restore into a NEW database (never over the live one)
const a = args()
const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is not set')
const s: BackupSettings = { adminUrl, pgBin: defaultPgBin(), dir: defaultBackupDir(), copyDir: null, key: parseKey(process.env.SYLKEN_BACKUP_KEY) }

try {
  const file = a.file ?? (await latestBackup(s.dir))
  if (!file) throw new Error(`no backups found in ${s.dir}`)
  if (a.to) {
    await restoreInto(s, file, a.to)
    console.log(`restored ${file} into the new database ${a.to}.`)
    console.log('To use it, point DATABASE_URL and DATABASE_ADMIN_URL in .env at that database and restart sylken.')
  } else {
    const r = await verifyBackup(s, file)
    console.log(`restore test of ${r.file}:`)
    for (const [t, n] of Object.entries(r.counts)) console.log(`  ${t.padEnd(16)} ${String(n).padStart(8)}  ${r.expected[t] === n ? 'ok' : `DIFFERENT (backed up ${r.expected[t]})`}`)
    console.log(r.ok ? 'RESTORE TEST PASSED: the backup restores, and every table has the rows it had.' : `RESTORE TEST FAILED:\n${r.mismatches.join('\n')}`)
    if (!r.ok) process.exit(1)
  }
} catch (e) {
  console.error('FAILED:', (e as Error).message)
  process.exit(1)
}
