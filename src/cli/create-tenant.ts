import { sql } from '../db/index.js'
import { createTenant } from '../domain/tenants.js'
import { args } from './args.js'

const a = args()
if (!a.slug || !a.name || !a.email || !a.password) {
  console.error('usage: npm run tenant:create -- --slug friends --name "Friends Pharmacy" --email you@example.com --password ... [--owner "Name"] [--address ...] [--phone ...]')
  process.exit(1)
}
const id = await createTenant(sql, {
  slug: a.slug, name: a.name, address: a.address, phone: a.phone,
  owner: { email: a.email, name: a.owner ?? a.email, password: a.password },
})
console.log(`created tenant ${a.slug} (${id})`)
await sql.end()
