import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Encryption of single fields at rest (AES-256-GCM), with a key that is never in the database
 * or in git. The key comes from SYLKEN_DATA_KEY (32 bytes, base64), or else from the key file
 * at SYLKEN_KEY_FILE (default data/sylken.key, ignored by git), which is created on first use.
 *
 * Losing the key loses everything encrypted with it, so the key file must be backed up
 * separately from the database. See docs/security/requirements.md, "What a person must check".
 */

let cached: Buffer | null = null

export function dataKey(): Buffer {
  if (cached) return cached
  const fromEnv = process.env.SYLKEN_DATA_KEY
  if (fromEnv) {
    const k = Buffer.from(fromEnv, 'base64')
    if (k.length !== 32) throw new Error('SYLKEN_DATA_KEY must be 32 bytes, base64')
    return (cached = k)
  }
  const file = resolve(process.env.SYLKEN_KEY_FILE ?? 'data/sylken.key')
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' })
  }
  try { chmodSync(file, 0o600) } catch { /* Windows: rely on the folder's permissions */ }
  const k = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
  if (k.length !== 32) throw new Error(`${file} does not hold a 32-byte base64 key`)
  return (cached = k)
}

/** Encrypt text; the result says which format it is in so the scheme can change later. */
export function seal(plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', dataKey(), iv)
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')
}

/** Decrypt what seal() made. Throws if the text was changed or the key is wrong. */
export function open(sealed: string): string {
  if (!sealed.startsWith('v1:')) throw new Error('unknown sealed format')
  const raw = Buffer.from(sealed.slice(3), 'base64')
  const d = createDecipheriv('aes-256-gcm', dataKey(), raw.subarray(0, 12))
  d.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
}

/** One-way hash for high-entropy tokens (session tokens, recovery codes). */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}
