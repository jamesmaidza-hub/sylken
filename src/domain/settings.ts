import type { Tx } from '../db/index.js'
import { num } from '../db/index.js'

export interface Settings {
  vatRate: number
  defaultMarkup: number
  retailRounding: number
  allowNegativeStock: boolean
  minmaxMinDays: number
  minmaxMaxDays: number
  minmaxUsageMonths: number
  maxSaneCost: number
  defaultFloat: number
  vatNumber: string | null
  receiptFooter: string | null
  timezone: string
}

export async function getSettings(tx: Tx): Promise<Settings> {
  const [s] = await tx`select * from tenant_settings`
  if (!s) throw new Error('tenant has no settings row')
  return {
    vatRate: num(s.vat_rate),
    defaultMarkup: num(s.default_markup),
    retailRounding: num(s.retail_rounding),
    allowNegativeStock: s.allow_negative_stock,
    minmaxMinDays: s.minmax_min_days,
    minmaxMaxDays: s.minmax_max_days,
    minmaxUsageMonths: s.minmax_usage_months,
    maxSaneCost: num(s.max_sane_cost),
    defaultFloat: num(s.default_float),
    vatNumber: s.vat_number,
    receiptFooter: s.receipt_footer,
    timezone: s.timezone,
  }
}

const columns: Record<keyof Settings, string> = {
  vatRate: 'vat_rate',
  defaultMarkup: 'default_markup',
  retailRounding: 'retail_rounding',
  allowNegativeStock: 'allow_negative_stock',
  minmaxMinDays: 'minmax_min_days',
  minmaxMaxDays: 'minmax_max_days',
  minmaxUsageMonths: 'minmax_usage_months',
  maxSaneCost: 'max_sane_cost',
  defaultFloat: 'default_float',
  vatNumber: 'vat_number',
  receiptFooter: 'receipt_footer',
  timezone: 'timezone',
}

export async function updateSettings(tx: Tx, patch: Partial<Settings>, userId?: string) {
  const row: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[columns[k as keyof Settings]] = v
  if (!Object.keys(row).length) return
  await tx`update tenant_settings set ${tx(row)}, updated_at = now()`
  await tx`insert into audit_log (tenant_id, user_id, action, entity, detail)
           values (current_setting('app.tenant_id')::uuid, ${userId ?? null}, 'update', 'settings', ${tx.json(row as any)})`
}
