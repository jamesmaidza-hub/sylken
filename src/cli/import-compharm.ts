import { writeFile } from 'node:fs/promises'
import { sql, withTenant } from '../db/index.js'
import { tenantBySlug } from '../domain/tenants.js'
import { importCompharm } from '../import/compharm.js'
import { args } from './args.js'

const a = args()
if (!a.tenant || !a.items) {
  console.error('usage: npm run import:compharm -- --tenant friends --items Item_List.xlsx [--minmax MinMax.xlsx] [--usage Usage.xlsx] [--sales Sales.csv] [--report import-report.json] [--all]')
  process.exit(1)
}
const tenant = await tenantBySlug(sql, a.tenant)
if (!tenant) throw new Error(`no tenant ${a.tenant}`)
const started = Date.now()
const report = await withTenant(sql, tenant.id, (tx) => importCompharm(tx, { itemList: a.items, minMax: a.minmax, usage: a.usage, salesCsv: a.sales, includeCatalogue: a.all === 'true' }))
const { issues, ...summary } = report
console.log(JSON.stringify(summary, null, 2))
const byType: Record<string, number> = {}
for (const i of issues) byType[i.issue] = (byType[i.issue] ?? 0) + 1
console.log('issues:', byType)
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
if (a.report) await writeFile(a.report, JSON.stringify(report, null, 2))
await sql.end()
