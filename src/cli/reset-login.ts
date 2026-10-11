import { sql, withTenant } from '../db/index.js'
import { resetSecondFactor, setPassword, unlockUser } from '../domain/users.js'
import { args } from './args.js'

// For whoever runs the server, when the only manager is locked out or has lost their phone
// and recovery codes. Every change is written to the pharmacy's audit log.
const a = args()
if (!a.email || !(a.unlock || a['reset-2fa'] || a.password)) {
  console.error('usage: npm run user:reset -- --email you@example.com [--unlock] [--reset-2fa] [--password NEW]')
  process.exit(1)
}
const [u] = await sql`select user_id, tenant_id from auth_lookup(${a.email})`
if (!u) {
  console.error(`no login has the email ${a.email}`)
  process.exit(1)
}
await withTenant(sql, u.tenant_id, async (tx) => {
  if (a.unlock) await unlockUser(tx, u.user_id, null)
  if (a['reset-2fa']) await resetSecondFactor(tx, u.user_id, null)
  if (a.password) await setPassword(tx, u.user_id, a.password, null)
  await tx`insert into audit_log (tenant_id, user_id, action, entity, entity_id, detail)
           values (${u.tenant_id}, null, 'server_reset', 'user', ${u.user_id}, ${tx.json({ unlock: !!a.unlock, reset2fa: !!a['reset-2fa'], password: !!a.password })})`
})
console.log(`done for ${a.email}`)
await sql.end()
