import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Sql } from './index.js'

const dir = fileURLToPath(new URL('../../migrations/', import.meta.url))

/** Apply pending migrations as the schema owner, then make sure the app role can use them. */
export async function migrate(admin: Sql, appRole = 'sylken_app', appPassword?: string) {
  await admin`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`
  const done = new Set((await admin`select name from schema_migrations`).map((r) => r.name as string))
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []
  for (const f of files) {
    if (done.has(f)) continue
    const text = await readFile(join(dir, f), 'utf8')
    await admin.begin(async (tx) => {
      await tx.unsafe(text)
      await tx`insert into schema_migrations (name) values (${f})`
    })
    applied.push(f)
  }
  const [role] = await admin`select 1 from pg_roles where rolname = ${appRole}`
  if (!role) {
    if (!appPassword) throw new Error(`role ${appRole} does not exist; pass a password to create it`)
    await admin.unsafe(`create role ${appRole} login password '${appPassword.replace(/'/g, "''")}'`)
  }
  await admin.unsafe(`grant usage on schema public to ${appRole};
    grant select, insert, update, delete on all tables in schema public to ${appRole};
    grant usage, select on all sequences in schema public to ${appRole};
    grant execute on all functions in schema public to ${appRole};`)
  return applied
}
