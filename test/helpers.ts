import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import type { Sql, Tx } from '../src/db/index.js'
import { withTenant } from '../src/db/index.js'
import { createTenant } from '../src/domain/tenants.js'

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
  return { id, slug, email, password, as: <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, id, fn) }
}
