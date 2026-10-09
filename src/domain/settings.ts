import type { Tx } from '../db/index.js'
import { num } from '../db/index.js'
import { DomainError } from './errors.js'

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
  dispensingFee: number
  defaultSupplyDays: number
  repeatValidDays: number
  registerSchedules: number[]
  labelWidthMm: number
  labelHeightMm: number
  labelFooter: string | null
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
    dispensingFee: num(s.dispensing_fee),
    defaultSupplyDays: s.default_supply_days,
    repeatValidDays: s.repeat_valid_days,
    registerSchedules: (s.register_schedules as number[]).map(Number),
    labelWidthMm: s.label_width_mm,
    labelHeightMm: s.label_height_mm,
    labelFooter: s.label_footer,
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
  dispensingFee: 'dispensing_fee',
  defaultSupplyDays: 'default_supply_days',
  repeatValidDays: 'repeat_valid_days',
  registerSchedules: 'register_schedules',
  labelWidthMm: 'label_width_mm',
  labelHeightMm: 'label_height_mm',
  labelFooter: 'label_footer',
}

export async function updateSettings(tx: Tx, patch: Partial<Settings>, userId?: string) {
  const row: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[columns[k as keyof Settings]] = v
  if (!Object.keys(row).length) return
  await tx`update tenant_settings set ${tx(row)}, updated_at = now()`
  await tx`insert into audit_log (tenant_id, user_id, action, entity, detail)
           values (current_setting('app.tenant_id')::uuid, ${userId ?? null}, 'update', 'settings', ${tx.json(row as any)})`
}

/** The pharmacy's own name, address and phone, printed on labels. */
export async function getShop(tx: Tx) {
  const [t] = await tx`select name, address, phone from tenants where id = current_setting('app.tenant_id')::uuid`
  return { name: t.name as string, address: t.address as string | null, phone: t.phone as string | null }
}

export async function updateShop(tx: Tx, shop: { address: string | null; phone: string | null }) {
  await tx`update tenants set address = ${shop.address}, phone = ${shop.phone} where id = current_setting('app.tenant_id')::uuid`
}

/** The next script number, so numbering can carry on from the old system. It can only go up. */
export async function nextScriptNo(tx: Tx): Promise<number> {
  const [c] = await tx`select value from tenant_counters where name = 'script'`
  return c ? Number(c.value) + 1 : 1
}

export async function setNextScriptNo(tx: Tx, next: number) {
  if (!Number.isInteger(next) || next < 1) throw new DomainError('the next script number must be a whole number')
  const current = await nextScriptNo(tx)
  if (next < current) throw new DomainError(`script numbers can only go up; the next one is already ${current}`)
  await tx`
    insert into tenant_counters (tenant_id, name, value) values (current_setting('app.tenant_id')::uuid, 'script', ${next - 1})
    on conflict (tenant_id, name) do update set value = excluded.value`
}
