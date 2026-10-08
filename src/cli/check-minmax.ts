import { sql, withTenant } from '../db/index.js'
import { minMaxOrderReport } from '../domain/minmax.js'
import { tenantBySlug } from '../domain/tenants.js'
import { compareMinMax } from '../import/check.js'
import { readCompharmMinMax } from '../import/compharm.js'
import { args } from './args.js'

const a = args()
if (!a.tenant || !a.minmax) {
  console.error('usage: npm run check:minmax -- --tenant friends --minmax MinMaxLevel.xlsx')
  process.exit(1)
}
const tenant = await tenantBySlug(sql, a.tenant)
if (!tenant) throw new Error(`no tenant ${a.tenant}`)
const ours = await withTenant(sql, tenant.id, (tx) => minMaxOrderReport(tx))
const theirs = await readCompharmMinMax(a.minmax)
const result = compareMinMax(theirs, ours)
console.log(JSON.stringify({ ...result, mismatches: result.mismatches.slice(0, 20) }, null, 2))
await sql.end()
process.exit(result.matched === theirs.length && result.extra.length === 0 ? 0 : 1)
