import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { backupDate, backupName, backupsToDelete, decryptFile, encryptFile, parseKey } from '../src/backup/crypto.js'

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'sylken-backup-test-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe('backup encryption', () => {
  it('encrypts so the data is unreadable, and decrypts it back exactly', async () => {
    const key = randomBytes(32)
    const secret = randomBytes(200_000)                                  // bigger than one stream chunk
    secret.write('PATIENT: MOTHIBI KAGISO', 100)
    await writeFile(join(dir, 'a.dump'), secret)
    await encryptFile(join(dir, 'a.dump'), join(dir, 'a.dump.enc'), key)
    const enc = await readFile(join(dir, 'a.dump.enc'))
    expect(enc.subarray(0, 8).toString()).toBe('SYLKBK01')
    expect(enc.includes(Buffer.from('MOTHIBI'))).toBe(false)             // not readable in the encrypted file
    expect(enc.length).toBe(secret.length + 8 + 12 + 16)
    await decryptFile(join(dir, 'a.dump.enc'), join(dir, 'a.out'), key)
    expect((await readFile(join(dir, 'a.out'))).equals(secret)).toBe(true)
  })

  it('refuses a wrong key, a changed file and something that is not a backup, leaving nothing behind', async () => {
    const key = randomBytes(32)
    await writeFile(join(dir, 'b.dump'), Buffer.from('a database dump'))
    await encryptFile(join(dir, 'b.dump'), join(dir, 'b.enc'), key)
    await expect(decryptFile(join(dir, 'b.enc'), join(dir, 'b1.out'), randomBytes(32))).rejects.toThrow(/wrong key|damaged/)
    const bytes = await readFile(join(dir, 'b.enc'))
    bytes[25] ^= 0xff                                                     // one changed byte in the data
    await writeFile(join(dir, 'b-tampered.enc'), bytes)
    await expect(decryptFile(join(dir, 'b-tampered.enc'), join(dir, 'b2.out'), key)).rejects.toThrow(/wrong key|damaged/)
    await writeFile(join(dir, 'c.txt'), Buffer.from('just a text file that is long enough to pass the size check'))
    await expect(decryptFile(join(dir, 'c.txt'), join(dir, 'c.out'), key)).rejects.toThrow(/not a sylken backup/)
    for (const f of ['b1.out', 'b2.out', 'c.out']) await expect(readFile(join(dir, f))).rejects.toThrow()
  })

  it('wants a key of 32 random bytes', () => {
    expect(() => parseKey(undefined)).toThrow(/32 random bytes/)
    expect(() => parseKey('c2hvcnQ=')).toThrow(/32 random bytes/)
    expect(parseKey(randomBytes(32).toString('base64'))).toHaveLength(32)
  })
})

describe('which backups to keep', () => {
  const at = (y: number, m: number, d: number, h = 22) => new Date(y, m - 1, d, h, 0, 0)
  const names = (dates: Date[]) => dates.map(backupName)

  it('names a backup by its date and reads the date back', () => {
    expect(backupName(at(2026, 10, 11))).toBe('sylken-20261011-220000.dump.enc')
    expect(backupDate('sylken-20261011-220000.dump.enc')).toEqual(at(2026, 10, 11))
    expect(backupDate('notes.txt')).toBeNull()
  })

  it('keeps 30 days, and the first of each month for a year, and never the files that are not backups', () => {
    const now = at(2026, 10, 11)
    const dates = [at(2025, 8, 3), at(2025, 8, 20), at(2025, 11, 2), at(2025, 11, 15), at(2026, 1, 9), at(2026, 1, 25), at(2026, 9, 5), at(2026, 9, 19), at(2026, 10, 1), at(2026, 10, 10)]
    const del = backupsToDelete([...names(dates), 'readme.txt'], now)
    // Aug 2025 is more than a year back, so both go. Of Nov 2025, Jan 2026 and Sep 2026 only the first of the month is kept.
    // Sep 19 is inside the last 30 days, so it stays too.
    expect(del.sort()).toEqual(names([at(2025, 8, 3), at(2025, 8, 20), at(2025, 11, 15), at(2026, 1, 25)]).sort())
  })

  it('never deletes the newest backup, even when it is old', () => {
    const now = at(2026, 10, 11)
    const old = names([at(2024, 1, 5), at(2024, 1, 6)])
    expect(backupsToDelete(old, now)).toEqual([backupName(at(2024, 1, 5))])
    expect(backupsToDelete([], now)).toEqual([])
  })
})
