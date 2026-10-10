import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import type { Sql, Tx } from '../src/db/index.js'
import { withTenant } from '../src/db/index.js'
import { createTenant } from '../src/domain/tenants.js'
import { createUser } from '../src/domain/users.js'
import type { Role } from '../src/security/roles.js'
import { codeAt, stepAt } from '../src/security/totp.js'

const adminUrl = process.env.TEST_ADMIN_URL ?? 'postgres://postgres@localhost:5433/postgres'
const u = new URL(adminUrl)

export function appDb(): Sql {
  return postgres(`postgres://sylken_test_app:sylken_test_app@${u.host}/sylken_test`, { max: 4, onnotice: () => {} })
}

export function adminDb(): Sql {
  const a = new URL(adminUrl)
  a.pathname = '/sylken_test'
  return postgres(a.toString(), { max: 2, onnotice: () => {} })
}

export async function newTenant(db: Sql, password = 'secret-pass-1') {
  const slug = `t-${randomUUID().slice(0, 8)}`
  const email = `${slug}@example.test`
  const id = await createTenant(db, { slug, name: `Pharmacy ${slug}`, owner: { email, name: 'Owner', password } })
  const [owner] = await withTenant(db, id, (tx) => tx`select id from users`)
  return { id, slug, email, password, userId: owner.id as string, as: <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, id, fn) }
}

// ---------------------------------------------------------------- logging in through the web app

const secrets = new Map<string, { secret: string; lastStep: number }>()

/** A code an authenticator app would show now, never the same one twice for a secret. */
export function nextCode(email: string): string {
  const s = secrets.get(email.toLowerCase())
  if (!s) throw new Error(`no authenticator set up for ${email} in this test run`)
  const step = Math.max(stepAt(), s.lastStep + 1)
  s.lastStep = step
  return codeAt(s.secret, step)
}

const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? ''

/**
 * Log in through the real screens, setting up the authenticator the first time for roles that
 * need one. Returns the session cookie.
 */
export async function webLogin(app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, email: string, password: string): Promise<string> {
  const res = await app.request('/login', { method: 'POST', body: new URLSearchParams({ email, password }) })
  const loc = res.headers.get('location')
  let cookie = cookieOf(res)
  if (loc === '/') return cookie
  if (loc === '/login/2fa/setup') {
    const page = await (await app.request('/login/2fa/setup', { headers: { cookie } })).text()
    const secret = page.match(/secret=([A-Z2-7]+)/)![1]
    secrets.set(email.toLowerCase(), { secret, lastStep: stepAt() - 2 })
    const done = await app.request('/login/2fa/setup', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ code: nextCode(email) }) })
    if (done.status !== 200) throw new Error(`second factor setup failed for ${email}`)
    return cookieOf(done)
  }
  if (loc === '/login/2fa') {
    const done = await app.request('/login/2fa', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ code: nextCode(email) }) })
    if (done.headers.get('location') !== '/') throw new Error(`second factor failed for ${email}`)
    cookie = cookieOf(done)
    return cookie
  }
  throw new Error(`login failed for ${email}: ${loc}`)
}

/** Another login in a test pharmacy, with the given roles. */
export async function addUser(db: Sql, tenantId: string, roles: Role[], name = roles.join('+')) {
  const email = `${name.replace(/\W/g, '')}-${randomUUID().slice(0, 6)}@example.test`
  const password = 'fake-pass-123'
  const id = await withTenant(db, tenantId, async (tx) => {
    const [boss] = await tx`select id from users where 'manager' = any(roles) limit 1`
    return createUser(tx, { email, name, roles, password }, boss.id)
  })
  return { id, email, password }
}
