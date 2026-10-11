import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import type { Sql, Tx } from '../src/db/index.js'
import { withTenant } from '../src/db/index.js'
import { createTenant } from '../src/domain/tenants.js'
import { createUser } from '../src/domain/users.js'
import type { Role } from '../src/security/roles.js'

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
  return { id, slug, email, password, staffCode: 'OW', userId: owner.id as string, as: <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, id, fn) }
}

// ---------------------------------------------------------------- logging in through the web app

/** The made-up second PIN every test login chooses. */
export const TEST_PIN = '284917'

const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? ''

/**
 * Log in through the real screens, choosing the second PIN the first time for roles that need
 * one. Returns the session cookie.
 */
export async function webLogin(app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, email: string, password: string): Promise<string> {
  const res = await app.request('/login', { method: 'POST', body: new URLSearchParams({ email, password }) })
  const loc = res.headers.get('location')
  const cookie = cookieOf(res)
  if (loc === '/') return cookie
  if (loc === '/login/2fa/setup' || loc === '/login/2fa') {
    const body: Record<string, string> = loc.endsWith('setup') ? { pin: TEST_PIN, again: TEST_PIN } : { pin: TEST_PIN }
    const done = await app.request(loc, { method: 'POST', headers: { cookie }, body: new URLSearchParams(body) })
    if (!done.headers.get('location')?.startsWith('/?') && done.headers.get('location') !== '/') throw new Error(`second PIN failed for ${email}: ${done.headers.get('location')}`)
    return cookieOf(done)
  }
  throw new Error(`login failed for ${email}: ${loc}`)
}

/** Another login in a test pharmacy, with the given roles. */
let nextCode = 0
/** The next unused 2-letter staff code: AA, AB, AC... (676 in all, plenty for a test run). */
const testCode = () => { const n = nextCode++; return String.fromCharCode(65 + (Math.floor(n / 26) % 26), 65 + (n % 26)) }

export async function addUser(db: Sql, tenantId: string, roles: Role[], name = roles.join('+')) {
  const email = `${name.replace(/\W/g, '')}-${randomUUID().slice(0, 6)}@example.test`
  const password = 'fake-pass-123'
  const staffCode = testCode()
  const id = await withTenant(db, tenantId, async (tx) => {
    const [boss] = await tx`select id from users where 'manager' = any(roles) limit 1`
    return createUser(tx, { email, name, roles, password, staffCode }, boss.id)
  })
  return { id, email, password, staffCode }
}

/**
 * A supervisor's approval written straight into the database, for tests of what the server does with
 * one. (How a supervisor gives one, with their code and second PIN, is tested in till-rules.test.ts.)
 */
export async function approvalFor(tx: Tx, tillId: string, subjectId: string, action: string, detail: Record<string, unknown> = {}) {
  const [boss] = await tx`select id from users where 'manager' = any(roles) limit 1`
  const [a] = await tx`
    insert into till_approvals (tenant_id, till_id, subject_id, action, detail, approved_by)
    values (current_setting('app.tenant_id')::uuid, ${tillId}, ${subjectId}, ${action}, ${tx.json(detail as any)}, ${boss.id}) returning id`
  return a.id as string
}
