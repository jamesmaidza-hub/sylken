import type { Sql } from '../db/index.js'
import { withTenant } from '../db/index.js'
import { hashPassword } from './auth.js'
import { defaultAdjustmentReasons } from './stock.js'

export interface NewTenant {
  slug: string
  name: string
  address?: string
  phone?: string
  owner: { email: string; name: string; password: string }
}

/** A new pharmacy: tenant row, default settings, adjustment reasons, its first owner login and one till. */
export async function createTenant(db: Sql, input: NewTenant): Promise<string> {
  const [t] = await db`insert into tenants (slug, name, address, phone) values (${input.slug}, ${input.name}, ${input.address ?? null}, ${input.phone ?? null}) returning id`
  const hash = await hashPassword(input.owner.password)
  await withTenant(db, t.id, async (tx) => {
    await tx`insert into tenant_settings (tenant_id) values (${t.id})`
    for (const [code, label] of defaultAdjustmentReasons) {
      await tx`insert into adjustment_reasons (tenant_id, code, label) values (${t.id}, ${code}, ${label})`
    }
    await tx`insert into users (tenant_id, email, name, role, password_hash) values (${t.id}, ${input.owner.email}, ${input.owner.name}, 'owner', ${hash})`
    await tx`insert into tills (tenant_id, code, name) values (${t.id}, 'T1', 'Till 1')`
  })
  return t.id
}

export async function tenantBySlug(db: Sql, slug: string): Promise<{ id: string; name: string } | null> {
  const [t] = await db`select id, name from tenants where slug = ${slug}`
  return t ? { id: t.id, name: t.name } : null
}

/** Remove a tenant and everything it owns. Needs the schema owner connection (ledger rows are otherwise immutable). */
export async function purgeTenant(admin: Sql, tenantId: string) {
  await admin.begin(async (tx) => {
    await tx`select set_config('sylken.purge', 'on', true)`
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`
    await tx`delete from tenants where id = ${tenantId}`
  })
}
