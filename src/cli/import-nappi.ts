import { sql, withTenant } from '../db/index.js'
import { tenantBySlug } from '../domain/tenants.js'
import { importNappi, writeUnmatched } from '../import/nappi.js'
import { args } from './args.js'

const a = args()
if (!a.tenant || !a.usage) {
  console.error('usage: npm run import:nappi -- --tenant friends --usage "Drug Usage.xlsx" [--unmatched not-matched.xlsx]')
  process.exit(1)
}
const tenant = await tenantBySlug(sql, a.tenant)
if (!tenant) throw new Error(`no tenant ${a.tenant}`)
const report = await withTenant(sql, tenant.id, (tx) => importNappi(tx, a.usage))
const why: Record<string, number> = {}
for (const u of report.unmatched) why[u.why] = (why[u.why] ?? 0) + 1
console.log(JSON.stringify({ rows: report.rows, matched: report.matched, unmatched: report.unmatched.length }, null, 2))
console.log('why not matched:', why)
if (a.unmatched) await writeUnmatched(report, a.unmatched)
await sql.end()
