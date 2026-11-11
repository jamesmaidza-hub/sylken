import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Backup files are encrypted with AES-256-GCM, so a copy of one that is lost or stolen cannot be read, and one that is
 * damaged or tampered with is refused instead of restored. File layout: 8-byte label, 12-byte random iv, the encrypted
 * data, then the 16-byte authentication tag. The key is 32 random bytes kept apart from the backups.
 */

const MAGIC = Buffer.from('SYLKBK01')
const IV_LEN = 12
const TAG_LEN = 16
const HEADER = MAGIC.length + IV_LEN

export function parseKey(b64: string | undefined): Buffer {
  const key = Buffer.from((b64 ?? '').trim(), 'base64')
  if (key.length !== 32) throw new Error('SYLKEN_BACKUP_KEY must be 32 random bytes in base64 (for example from: openssl rand -base64 32)')
  return key
}

export async function encryptFile(src: string, dest: string, key: Buffer): Promise<void> {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(MAGIC)
  const out = createWriteStream(dest)
  out.write(Buffer.concat([MAGIC, iv]))
  // The tag only exists once the cipher has finished, so it is appended as the last thing written.
  const withTag = new Transform({
    transform(chunk, _enc, cb) { cb(null, chunk) },
    flush(cb) { cb(null, cipher.getAuthTag()) },
  })
  try {
    await pipeline(createReadStream(src), cipher, withTag, out)
  } catch (e) {
    await rm(dest, { force: true })
    throw e
  }
}

/** Decrypt a backup. A wrong key, a damaged file or a changed file all fail, and nothing is left at dest. */
export async function decryptFile(src: string, dest: string, key: Buffer): Promise<void> {
  const fh = await open(src, 'r')
  let size: number
  let header: Buffer
  let tag: Buffer
  try {
    size = (await fh.stat()).size
    if (size < HEADER + TAG_LEN) throw new Error('this is not a sylken backup (too short)')
    header = Buffer.alloc(HEADER)
    await fh.read(header, 0, HEADER, 0)
    tag = Buffer.alloc(TAG_LEN)
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN)
  } finally {
    await fh.close()
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('this is not a sylken backup (wrong label)')
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length))
  decipher.setAAD(MAGIC)
  decipher.setAuthTag(tag)
  try {
    await pipeline(createReadStream(src, { start: HEADER, end: size - TAG_LEN - 1 }), decipher, createWriteStream(dest))
  } catch {
    await rm(dest, { force: true })
    throw new Error('the backup could not be decrypted: wrong key, or the file is damaged or has been changed')
  }
}

// ---------------------------------------------------------------- which backups to keep

const NAME = /^sylken-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.dump\.enc$/

export const backupName = (d: Date) => {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `sylken-${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.dump.enc`
}

export const backupDate = (name: string): Date | null => {
  const m = NAME.exec(name)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : null
}

/**
 * Which backups to delete. Every backup from the last `keepDays` days is kept, plus the first backup of each of the last
 * `keepMonths` months (the older monthly ones), and the newest backup is never deleted. Names that are not backups are left alone.
 */
export function backupsToDelete(names: string[], now: Date, keepDays = 30, keepMonths = 12): string[] {
  const backups = names.map((n) => ({ n, d: backupDate(n) })).filter((b): b is { n: string; d: Date } => b.d !== null).sort((a, b) => a.d.getTime() - b.d.getTime())
  if (!backups.length) return []
  const newest = backups[backups.length - 1].n
  const cutoff = now.getTime() - keepDays * 86_400_000
  const monthKey = (d: Date) => d.getFullYear() * 12 + d.getMonth()
  const thisMonth = monthKey(now)
  const firstOfMonth = new Map<number, string>()
  for (const b of backups) if (!firstOfMonth.has(monthKey(b.d))) firstOfMonth.set(monthKey(b.d), b.n)
  return backups
    .filter((b) => b.n !== newest && b.d.getTime() < cutoff)
    .filter((b) => !(thisMonth - monthKey(b.d) < keepMonths && firstOfMonth.get(monthKey(b.d)) === b.n))
    .map((b) => b.n)
}
