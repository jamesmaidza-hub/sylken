import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import postgres from 'postgres'
import { backupName, backupsToDelete, decryptFile, encryptFile } from './crypto.js'

const run = promisify(execFile)

/** Row counts taken at the moment of the backup, so a restored copy can be checked against them. */
export const countedTables = ['tenants', 'users', 'items', 'stock_movements', 'patients', 'scripts', 'script_lines', 'sales', 'sale_lines', 'till_runs', 'z_reports', 'audit_log'] as const

export interface BackupSettings {
  /** Superuser connection to the database, e.g. postgres://postgres:...@localhost:5432/sylken */
  adminUrl: string
  /** Folder holding the PostgreSQL command line tools (pg_dump, pg_restore); empty means they are on the PATH. */
  pgBin: string
  /** Where backups are kept on this computer. */
  dir: string
  /** A second place (a USB drive, a synced folder) that each backup is copied to as well. */
  copyDir?: string | null
  key: Buffer
}

export interface BackupMeta {
  file: string
  at: string
  bytes: number
  sha256: string
  counts: Record<string, number>
  copied: boolean
  copyError?: string
}
export interface BackupStatus { lastSuccess?: BackupMeta; lastFailure?: { at: string; error: string } }

export const defaultBackupDir = () => process.env.SYLKEN_BACKUP_DIR || join(homedir(), 'sylken-backups')
export const defaultPgBin = () => process.env.PG_BIN ?? (process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\16\\bin' : '')
export const pgTool = (pgBin: string, tool: string) => (pgBin ? join(pgBin, tool + (process.platform === 'win32' ? '.exe' : '')) : tool)

/** The connection details pg_dump and pg_restore need, from a postgres:// address. The password goes in the environment, not on the command line. */
export function pgArgs(adminUrl: string, db?: string) {
  const u = new URL(adminUrl)
  return {
    args: ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username), '-d', db ?? u.pathname.slice(1)],
    env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) },
    db: db ?? u.pathname.slice(1),
  }
}

export async function sha256(file: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(file)) h.update(chunk)
  return h.digest('hex')
}

export async function readStatus(dir: string): Promise<BackupStatus> {
  try { return JSON.parse(await readFile(join(dir, 'backup-status.json'), 'utf8')) } catch { return {} }
}
async function writeStatus(dir: string, patch: BackupStatus) {
  const next = { ...(await readStatus(dir)), ...patch }
  const tmp = join(dir, 'backup-status.json.tmp')
  await writeFile(tmp, JSON.stringify(next, null, 2))
  await rename(tmp, join(dir, 'backup-status.json'))
}

export async function countRows(sql: postgres.Sql | postgres.TransactionSql): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of countedTables) out[t] = Number((await sql.unsafe(`select count(*)::int as n from ${t}`))[0].n)
  return out
}

/**
 * Back up the database: a consistent copy (one snapshot, so the dump and the row counts agree), encrypted, with a
 * checksum, a second copy if one is set, and old backups tidied away. A failure is recorded and thrown.
 */
export async function runBackup(s: BackupSettings, now = new Date()): Promise<BackupMeta> {
  await mkdir(s.dir, { recursive: true })
  const name = backupName(now)
  const tmp = join(s.dir, name.replace('.dump.enc', '.dump.tmp'))
  const final = join(s.dir, name)
  const sql = postgres(s.adminUrl, { max: 1, onnotice: () => {} })
  try {
    const counts = await sql.begin('isolation level repeatable read', async (tx) => {
      const [{ snap }] = await tx`select pg_export_snapshot() as snap`
      const { args, env } = pgArgs(s.adminUrl)
      await run(pgTool(s.pgBin, 'pg_dump'), [...args, '-Fc', `--snapshot=${snap}`, '-f', tmp], { env, maxBuffer: 1 << 24 })
      return countRows(tx)
    }) as Record<string, number>
    await encryptFile(tmp, final, s.key)
    await rm(tmp, { force: true })
    const meta: BackupMeta = { file: name, at: now.toISOString(), bytes: (await stat(final)).size, sha256: await sha256(final), counts, copied: false }
    await writeFile(join(s.dir, name.replace('.dump.enc', '.meta.json')), JSON.stringify(meta, null, 2))
    if (s.copyDir) {
      try {
        await mkdir(s.copyDir, { recursive: true })
        await copyFile(final, join(s.copyDir, name))
        await copyFile(join(s.dir, name.replace('.dump.enc', '.meta.json')), join(s.copyDir, name.replace('.dump.enc', '.meta.json')))
        if ((await sha256(join(s.copyDir, name))) !== meta.sha256) throw new Error('the copy does not match the original')
        meta.copied = true
      } catch (e) { meta.copyError = (e as Error).message }
    }
    await prune(s.dir, now)
    if (s.copyDir && meta.copied) await prune(s.copyDir, now)
    await writeStatus(s.dir, { lastSuccess: meta })
    return meta
  } catch (e) {
    await rm(tmp, { force: true })
    await writeStatus(s.dir, { lastFailure: { at: now.toISOString(), error: (e as Error).message.slice(0, 500) } }).catch(() => {})
    throw e
  } finally {
    await sql.end()
  }
}

async function prune(dir: string, now: Date) {
  for (const n of backupsToDelete(await readdir(dir), now)) {
    await rm(join(dir, n), { force: true })
    await rm(join(dir, n.replace('.dump.enc', '.meta.json')), { force: true })
  }
}

export interface RestoreCheck { file: string; ok: boolean; counts: Record<string, number>; expected: Record<string, number>; mismatches: string[] }

/** Newest backup file in a folder, or null. */
export async function latestBackup(dir: string): Promise<string | null> {
  const names = (await readdir(dir).catch(() => [])).filter((n) => /^sylken-\d{8}-\d{6}\.dump\.enc$/.test(n)).sort()
  return names.length ? join(dir, names[names.length - 1]) : null
}

/** Decrypt a backup and restore it into a NEW database (never over the live one). Returns once it is restored. */
export async function restoreInto(s: BackupSettings, file: string, newDb: string): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(newDb)) throw new Error('the database name must be lower case letters, numbers and underscores')
  const tmp = join(s.dir, `restore-${Date.now()}.dump.tmp`)
  const admin = postgres(s.adminUrl.replace(/\/[^/]*$/, '/postgres'), { max: 1, onnotice: () => {} })
  try {
    const [exists] = await admin`select 1 from pg_database where datname = ${newDb}`
    if (exists) throw new Error(`a database called ${newDb} already exists; a restore only goes into a new one`)
    await decryptFile(file, tmp, s.key)
    await admin.unsafe(`create database ${newDb}`)
    const { args, env } = pgArgs(s.adminUrl, newDb)
    await run(pgTool(s.pgBin, 'pg_restore'), [...args, '--no-owner', '--no-privileges', tmp], { env, maxBuffer: 1 << 24 })
  } finally {
    await rm(tmp, { force: true })
    await admin.end()
  }
}

/**
 * Prove a backup works: restore it into a temporary database, count the same tables, compare with the counts taken when the
 * backup was made, then remove the temporary database. This is the "restore test".
 */
export async function verifyBackup(s: BackupSettings, file: string): Promise<RestoreCheck> {
  const name = basename(file)
  const meta: BackupMeta = JSON.parse(await readFile(join(dirname(file), name.replace('.dump.enc', '.meta.json')), 'utf8'))
  const tmpDb = `sylken_verify_${Date.now()}`
  await restoreInto(s, file, tmpDb)
  const admin = postgres(s.adminUrl.replace(/\/[^/]*$/, '/postgres'), { max: 1, onnotice: () => {} })
  const check = postgres(s.adminUrl.replace(/\/[^/]*$/, `/${tmpDb}`), { max: 1, onnotice: () => {} })
  try {
    const counts = await countRows(check)
    const mismatches = countedTables.filter((t) => counts[t] !== meta.counts[t]).map((t) => `${t}: backed up ${meta.counts[t]}, restored ${counts[t]}`)
    return { file: name, ok: mismatches.length === 0, counts, expected: meta.counts, mismatches }
  } finally {
    await check.end()
    await admin.unsafe(`drop database if exists ${tmpDb} with (force)`)
    await admin.end()
  }
}
