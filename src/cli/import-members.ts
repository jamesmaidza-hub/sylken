import { writeFile } from 'node:fs/promises'
import { sql, withTenant } from '../db/index.js'
import { tenantBySlug } from '../domain/tenants.js'
import { importMembers } from '../import/members.js'
import { args } from './args.js'

const a = args()
if (!a.tenant || !a.members) {
  console.error('usage: npm run import:members -- --tenant friends --members "Members Report.xlsx" [--report members-report.json]')
  process.exit(1)
}
const tenant = await tenantBySlug(sql, a.tenant)
if (!tenant) throw new Error(`no tenant ${a.tenant}`)
const started = Date.now()
const report = await withTenant(sql, tenant.id, (tx) => importMembers(tx, a.members))
const { issues, ...summary } = report
console.log(JSON.stringify(summary, null, 2))
console.log('issues:', issues.length)
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
if (a.report) await writeFile(a.report, JSON.stringify(report, null, 2))
await sql.end()
