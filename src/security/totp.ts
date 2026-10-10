import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Time-based one-time passwords (RFC 6238), the six-digit codes from an authenticator app
 * (Google Authenticator, Microsoft Authenticator, Authy). SHA-1, 30-second steps, 6 digits:
 * the defaults every app supports.
 */

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const STEP = 30

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0, value = 0
  const out: number[] = []
  for (const ch of clean) {
    const i = alphabet.indexOf(ch)
    if (i < 0) throw new Error('not base32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Buffer.from(out)
}

/** A new 160-bit secret, base32 as the apps expect it. */
export function newSecret(): string {
  return base32Encode(randomBytes(20))
}

export function stepAt(time = Date.now()): number {
  return Math.floor(time / 1000 / STEP)
}

export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const o = h[h.length - 1] & 15
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000
  return String(n).padStart(6, '0')
}

/**
 * The time step a code belongs to, allowing one step either side for a phone clock that is a
 * little out, or null. Steps at or before lastStep are refused so a code can't be used twice.
 */
export function verifyCode(secret: string, code: string, lastStep: number | null, time = Date.now()): number | null {
  const given = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(given)) return null
  const now = stepAt(time)
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue
    if (timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(given))) return step
  }
  return null
}

/** The link an authenticator app reads (as a QR code or typed in). */
export function otpauthUri(secret: string, account: string, issuer = 'sylken'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`
}
