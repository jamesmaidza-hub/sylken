import { sql, withTenant } from '../db/index.js'
import { tenantBySlug } from '../domain/tenants.js'
import { importAbcSales } from '../import/abc-sales.js'
import { args } from './args.js'

const a = args()
if (!a.tenant || !a.usage) {
  console.error('usage: npm run import:abc -- --tenant friends --usage "Stock_Usage_Performers.xlsx" [--source "Compharm stock usage"]')
  process.exit(1)
}
const tenant = await tenantBySlug(sql, a.tenant)
if (!tenant) throw new Error(`no tenant ${a.tenant}`)
const r = await withTenant(sql, tenant.id, (tx) => importAbcSales(tx, a.usage, a.source))
console.log(JSON.stringify({ source: r.source, from: r.from, to: r.to, rows: r.rows, loaded: r.loaded, notInSylken: r.notInSylken.length }, null, 2))
if (r.notInSylken.length) console.log('not in sylken (first 10):', r.notInSylken.slice(0, 10))
await sql.end()
