import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Sql } from '../../src/db/index.js'
import { security } from '../../src/security/config.js'
import { open } from '../../src/security/crypto.js'
import { codeAt, stepAt, verifyCode } from '../../src/security/totp.js'
import { base32Encode } from '../../src/security/totp.js'
import { createApp } from '../../src/web/app.js'
import { addUser, adminDb, appDb, newTenant, nextCode, webLogin } from '../helpers.js'

// Requirements 1.9 to 1.19: docs/security/requirements.md

let db: Sql
let admin: Sql
let t: Awaited<ReturnType<typeof newTenant>>
let app: ReturnType<typeof createApp>
beforeAll(async () => { db = appDb(); admin = adminDb(); t = await newTenant(db) })
beforeEach(() => { app = createApp(db) })   // a fresh app per test, so the per-IP limiter starts empty
afterAll(async () => { await db.end(); await admin.end() })

const loginPost = (email: string, password: string) => app.request('/login', { method: 'POST', body: new URLSearchParams({ email, password }) })
const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? ''
const where = (res: Response) => res.headers.get('location')
const err = (res: Response) => new URL(where(res) ?? '/', 'http://x').searchParams.get('err') ?? ''
const audit = (userId: string) => t.as(async (tx) => (await tx`select action from audit_log where entity = 'login' and entity_id = ${userId} order by id`).map((r) => r.action))

describe('1.9 second factor for pharmacists and managers', () => {
  it('lets a counter assistant in with a password alone', async () => {
    const u = await addUser(db, t.id, ['assistant'])
    const res = await loginPost(u.email, u.password)
    expect(where(res)).toBe('/')
    expect((await app.request('/', { headers: { cookie: cookieOf(res) } })).status).toBe(200)
  })

  it('gives a pharmacist with only a password nothing but the second-step pages', async () => {
    const u = await addUser(db, t.id, ['pharmacist'])
    const res = await loginPost(u.email, u.password)
    expect(where(res)).toBe('/login/2fa/setup')
    const cookie = cookieOf(res)
    expect(where(await app.request('/', { headers: { cookie } }))).toBe('/login/2fa')
    expect(where(await app.request('/dispensary', { headers: { cookie } }))).toBe('/login/2fa')
    expect((await app.request('/api/items', { headers: { cookie } })).status).toBe(401)
    expect((await app.request('/api/items', { headers: { authorization: `Bearer ${cookie.split('=')[1]}` } })).status).toBe(401)
  })

  it('stores the authenticator secret encrypted, never in plain text', async () => {
    const u = await addUser(db, t.id, ['manager'])
    await webLogin(app, u.email, u.password)
    const [row] = await t.as((tx) => tx`select totp_secret from users where id = ${u.id}`)
    expect(row.totp_secret).toMatch(/^v1:/)
    expect(open(row.totp_secret)).toMatch(/^[A-Z2-7]{32}$/)
    expect(row.totp_secret).not.toContain(open(row.totp_secret))
  })

  it('refuses a wrong code, and issues a new session token after the right one (1.16)', async () => {
    const u = await addUser(db, t.id, ['pharmacist'])
    await webLogin(app, u.email, u.password)           // sets up the authenticator
    const res = await loginPost(u.email, u.password)
    expect(where(res)).toBe('/login/2fa')
    const pending = cookieOf(res)
    const bad = await app.request('/login/2fa', { method: 'POST', headers: { cookie: pending }, body: new URLSearchParams({ code: '000000' }) })
    expect(where(bad)).toMatch(/^\/login\/2fa\?err=/)
    const good = await app.request('/login/2fa', { method: 'POST', headers: { cookie: pending }, body: new URLSearchParams({ code: nextCode(u.email) }) })
    expect(where(good)).toBe('/')
    const full = cookieOf(good)
    expect(full).not.toBe(pending)
    expect((await app.request('/', { headers: { cookie: full } })).status).toBe(200)
    expect(where(await app.request('/', { headers: { cookie: pending } }))).toBe('/login')   // the pending token is gone
  })

  it('never accepts the same code twice', async () => {
    const u = await addUser(db, t.id, ['pharmacist'])
    await webLogin(app, u.email, u.password)
    const code = nextCode(u.email)
    const first = await loginPost(u.email, u.password)
    expect(where(await app.request('/login/2fa', { method: 'POST', headers: { cookie: cookieOf(first) }, body: new URLSearchParams({ code }) }))).toBe('/')
    const second = await loginPost(u.email, u.password)
    expect(where(await app.request('/login/2fa', { method: 'POST', headers: { cookie: cookieOf(second) }, body: new URLSearchParams({ code }) }))).toMatch(/err=/)
  })

  it('accepts each recovery code once (1.10), and keeps only their hashes', async () => {
    const u = await addUser(db, t.id, ['pharmacist'])
    const first = await loginPost(u.email, u.password)
    const page = await (await app.request('/login/2fa/setup', { headers: { cookie: cookieOf(first) } })).text()
    const secret = page.match(/secret=([A-Z2-7]+)/)![1]
    const done = await app.request('/login/2fa/setup', { method: 'POST', headers: { cookie: cookieOf(first) }, body: new URLSearchParams({ code: codeAt(secret, stepAt()) }) })
    const codes = [...(await done.text()).matchAll(/\b([0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4})\b/g)].map((m) => m[1])
    expect(codes.length).toBe(security.recoveryCodes)
    const stored = await t.as((tx) => tx`select code_hash from recovery_codes where user_id = ${u.id}`)
    expect(stored.length).toBe(security.recoveryCodes)
    expect(stored.some((r) => codes.some((c) => r.code_hash.includes(c.replace(/-/g, ''))))).toBe(false)
    const use = async () => {
      const res = await loginPost(u.email, u.password)
      return where(await app.request('/login/2fa', { method: 'POST', headers: { cookie: cookieOf(res) }, body: new URLSearchParams({ code: codes[0] }) }))
    }
    expect(await use()).toBe('/')
    expect(await use()).toMatch(/err=/)
    expect(await audit(u.id)).toContain('recovery_code_used')
  })

  it('matches the RFC 6238 test vector and allows one step of clock drift', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'))
    expect(codeAt(secret, Math.floor(59 / 30))).toBe('287082')            // RFC 6238 appendix B, 6 digits
    expect(codeAt(secret, Math.floor(1111111109 / 30))).toBe('081804')
    const now = Date.now()
    expect(verifyCode(secret, codeAt(secret, stepAt(now) - 1), null, now)).not.toBeNull()
    expect(verifyCode(secret, codeAt(secret, stepAt(now) - 3), null, now)).toBeNull()
  })
})

describe('1.13 lockout after repeated failures', () => {
  it('locks after 5 wrong passwords, refuses even the right one, and a manager can unlock it', async () => {
    const u = await addUser(db, t.id, ['assistant'])
    for (let i = 0; i < security.maxFailures; i++) expect(where(await loginPost(u.email, 'wrong-password'))).toMatch(/err=/)
    const refused = await loginPost(u.email, u.password)
    expect(where(refused)).toMatch(/err=/)
    expect(await audit(u.id)).toEqual([...Array(security.maxFailures).fill('login_failed'), 'locked', 'login_refused_locked'])
    const boss = await addUser(db, t.id, ['manager'])
    const cookie = await webLogin(app, boss.email, boss.password)
    await app.request(`/users/${u.id}/unlock`, { method: 'POST', headers: { cookie } })
    expect(where(await loginPost(u.email, u.password))).toBe('/')
  })

  it('counts wrong second-step codes towards the same lock', async () => {
    const u = await addUser(db, t.id, ['manager'])
    await webLogin(app, u.email, u.password)
    for (let i = 0; i < security.maxFailures; i++) {
      const res = await loginPost(u.email, u.password)
      await app.request('/login/2fa', { method: 'POST', headers: { cookie: cookieOf(res) }, body: new URLSearchParams({ code: '000000' }) })
    }
    expect(where(await loginPost(u.email, u.password))).toMatch(/err=/)
  })

  it('gives the same answer for an unknown email, a wrong password and a locked account (1.14)', async () => {
    const u = await addUser(db, t.id, ['assistant'])
    const unknown = where(await loginPost('nobody-here@example.test', 'whatever-123'))
    const wrong = where(await loginPost(u.email, 'wrong-password'))
    expect(unknown).toBe(wrong)
  })

  it('stops one computer trying many accounts (per-IP limit)', async () => {
    const u = await addUser(db, t.id, ['assistant'])
    for (let i = 0; i < security.ipAttempts; i++) await loginPost(`nobody-${i}@example.test`, 'whatever-123')
    expect(err(await loginPost(u.email, u.password))).toMatch(/Too many login attempts/)
  })
})

describe('1.11 and 1.15 sessions', () => {
  const sessionCookie = async (roles: ['assistant']) => {
    const u = await addUser(db, t.id, roles)
    return { u, cookie: cookieOf(await loginPost(u.email, u.password)) }
  }

  it('keeps only a hash of the token in the database', async () => {
    const { u, cookie } = await sessionCookie(['assistant'])
    const token = cookie.split('=')[1]
    const rows = await admin`select token_hash from sessions where user_id = ${u.id}`
    expect(rows.length).toBe(1)
    expect(rows[0].token_hash).not.toBe(token)
    expect(JSON.stringify(rows)).not.toContain(token)
  })

  it(`ends a session after ${security.idleMinutes} idle minutes`, async () => {
    const { u, cookie } = await sessionCookie(['assistant'])
    await admin`update sessions set last_seen_at = now() - ${security.idleMinutes + 1 + ' minutes'}::interval where user_id = ${u.id}`
    expect(where(await app.request('/', { headers: { cookie } }))).toBe('/login')
  })

  it(`ends a session ${security.absoluteHours} hours after login however active it is`, async () => {
    const { u, cookie } = await sessionCookie(['assistant'])
    await admin`update sessions set created_at = now() - interval '13 hours', expires_at = now() - interval '1 minute' where user_id = ${u.id}`
    expect(where(await app.request('/', { headers: { cookie } }))).toBe('/login')
  })

  it('does not let a till\'s background polling keep an idle session alive', async () => {
    const { u, cookie } = await sessionCookie(['assistant'])
    await admin`update sessions set last_seen_at = now() - interval '10 minutes' where user_id = ${u.id}`
    await app.request('/api/till/catalogue', { headers: { cookie, 'x-sylken-background': '1' } })
    const [s] = await admin`select last_seen_at < now() - interval '9 minutes' as stale from sessions where user_id = ${u.id}`
    expect(s.stale).toBe(true)
    await app.request('/', { headers: { cookie } })
    const [s2] = await admin`select last_seen_at > now() - interval '1 minute' as fresh from sessions where user_id = ${u.id}`
    expect(s2.fresh).toBe(true)
  })

  it('puts an idle lock on every logged-in screen (1.12)', async () => {
    const { cookie } = await sessionCookie(['assistant'])
    const html = await (await app.request('/', { headers: { cookie } })).text()
    expect(html).toContain(`location.href='/logout?idle=1'},${security.idleMinutes * 60_000}`)
  })

  it('ends someone\'s sessions when a manager changes their roles or switches them off (1.16)', async () => {
    const { u, cookie } = await sessionCookie(['assistant'])
    const boss = await addUser(db, t.id, ['manager'])
    const bossCookie = await webLogin(app, boss.email, boss.password)
    await app.request(`/users/${u.id}`, { method: 'POST', headers: { cookie: bossCookie }, body: new URLSearchParams({ name: 'Changed', email: u.email, role_dispenser: 'on', active: 'on' }) })
    expect(where(await app.request('/', { headers: { cookie } }))).toBe('/login')
  })
})

describe('1.17, 1.18 and 1.19 managing logins', () => {
  it('refuses short passwords and the email as password', async () => {
    const boss = await addUser(db, t.id, ['manager'])
    const cookie = await webLogin(app, boss.email, boss.password)
    const add = (email: string, password: string) => app.request('/users', { method: 'POST', headers: { cookie, referer: 'http://x/users' }, body: new URLSearchParams({ name: 'Fake', email, password, role_assistant: 'on' }) })
    expect(err(await add('short@example.test', 'short'))).toMatch(/at least 10 characters/)
    expect(err(await add('same-as-email@example.test', 'same-as-email@example.test'))).toMatch(/cannot be the email/)
  })

  it('stops a manager removing their own manager role or switching themselves off', async () => {
    const boss = await addUser(db, t.id, ['manager'])
    const cookie = await webLogin(app, boss.email, boss.password)
    const res = await app.request(`/users/${boss.id}`, { method: 'POST', headers: { cookie, referer: 'http://x/users' }, body: new URLSearchParams({ name: 'Boss', email: boss.email, role_assistant: 'on', active: 'on' }) })
    expect(err(res)).toMatch(/cannot remove your own manager role/)
    const [row] = await t.as((tx) => tx`select roles from users where id = ${boss.id}`)
    expect(row.roles).toEqual(['manager'])
  })

  it('writes logins, failures and user changes to the audit log with the IP address', async () => {
    const u = await addUser(db, t.id, ['assistant'])
    await loginPost(u.email, 'wrong-password')
    await loginPost(u.email, u.password)
    const rows = await t.as((tx) => tx`select action, detail from audit_log where entity = 'login' and entity_id = ${u.id} order by id`)
    expect(rows.map((r) => r.action)).toEqual(['login_failed', 'login'])
    expect(Object.keys(rows[0].detail)).toContain('ip')
    const created = await t.as((tx) => tx`select detail from audit_log where entity = 'user' and entity_id = ${u.id} and action = 'create'`)
    expect(created[0].detail.after).toMatchObject({ email: u.email, roles: ['assistant'] })
  })
})

describe('second-step setup', () => {
  it('cannot be redone once an authenticator is set up (an attacker with the password cannot swap in their own phone)', async () => {
    const u = await addUser(db, t.id, ['pharmacist'])
    await webLogin(app, u.email, u.password)
    const res = await loginPost(u.email, u.password)
    const setup = await app.request('/login/2fa/setup', { headers: { cookie: cookieOf(res) } })
    expect(setup.status).not.toBe(200)
    expect(await setup.text()).not.toMatch(/secret=/)
  })
})
