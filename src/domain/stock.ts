import type { Tx } from '../db/index.js'
import { DomainError } from './errors.js'
import { getSettings } from './settings.js'

export type MovementKind =
  | 'opening' | 'receipt' | 'supplier_return' | 'sale' | 'sale_return'
  | 'dispense' | 'adjustment' | 'stocktake' | 'transfer_in' | 'transfer_out'

export interface MovementInput {
  id?: string                // client-generated for offline tills; resending is a no-op
  itemId: string
  kind: MovementKind
  qtyUnits: number           // signed
  unitCost?: number | null
  unitRetail?: number | null
  reasonCode?: string | null
  refType?: string | null
  refId?: string | null
  note?: string | null
  deviceId?: string | null
  occurredAt?: Date
}

/** Kinds that take stock off the shelf and are blocked from going negative unless overridden. */
const guarded = new Set<MovementKind>(['sale', 'dispense', 'adjustment', 'supplier_return', 'transfer_out'])

export interface PostOptions {
  userId?: string | null
  allowNegative?: boolean    // a pharmacist or owner overriding the negative-stock block
}

/** Post movements to the ledger. Returns the ids that were newly recorded. */
export async function postMovements(tx: Tx, movements: MovementInput[], opts: PostOptions = {}): Promise<string[]> {
  if (!movements.length) return []
  const settings = await getSettings(tx)
  const ids = [...new Set(movements.map((m) => m.itemId))]
  const levels = await tx`
    select i.id, i.stock_code, i.status, coalesce(s.on_hand_units, 0) as on_hand
      from items i left join stock_levels s on s.item_id = i.id
     where i.id = any(${ids}::uuid[]) for update of i`
  const byId = new Map(levels.map((r) => [r.id as string, { code: r.stock_code as string, status: r.status as string, onHand: r.on_hand as number }]))
  const recorded: string[] = []
  for (const m of movements) {
    const lvl = byId.get(m.itemId)
    if (!lvl) throw new DomainError(`unknown item ${m.itemId}`, 'not_found', 404)
    if (!Number.isInteger(m.qtyUnits) || m.qtyUnits === 0) throw new DomainError('quantity must be a non-zero whole number of units')
    if ((m.kind === 'sale' || m.kind === 'dispense') && lvl.status === 'quarantined') {
      throw new DomainError(`${lvl.code} is quarantined and can't be sold until its record is fixed`, 'quarantined', 409)
    }
    const after = lvl.onHand + m.qtyUnits
    if (m.qtyUnits < 0 && guarded.has(m.kind) && after < 0 && !settings.allowNegativeStock && !opts.allowNegative) {
      throw new DomainError(`${lvl.code}: only ${lvl.onHand} units on hand`, 'insufficient_stock', 409)
    }
    const [row] = await tx`
      insert into stock_movements
        (id, tenant_id, item_id, kind, qty_units, unit_cost, unit_retail, reason_code, ref_type, ref_id, note, user_id, device_id, occurred_at)
      values (coalesce(${m.id ?? null}::uuid, gen_random_uuid()), current_setting('app.tenant_id')::uuid, ${m.itemId}, ${m.kind}, ${m.qtyUnits},
              ${m.unitCost ?? null}, ${m.unitRetail ?? null}, ${m.reasonCode ?? null}, ${m.refType ?? null}, ${m.refId ?? null},
              ${m.note ?? null}, ${opts.userId ?? null}, ${m.deviceId ?? null}, ${m.occurredAt ?? new Date()})
      on conflict (id) do nothing
      returning id`
    if (row) {
      recorded.push(row.id)
      lvl.onHand = after
    }
  }
  return recorded
}

/** Manual stock adjustment with a reason. Positive or negative units. */
export async function adjustStock(
  tx: Tx,
  input: { itemId: string; qtyUnits: number; reasonCode: string; note?: string },
  opts: PostOptions = {},
) {
  const [reason] = await tx`select code from adjustment_reasons where code = ${input.reasonCode} and active`
  if (!reason) throw new DomainError(`unknown adjustment reason ${input.reasonCode}`)
  const [item] = await tx`select avg_cost_per_pack, cost_per_pack, pack_size from items where id = ${input.itemId}`
  if (!item) throw new DomainError('unknown item', 'not_found', 404)
  const unitCost = item.avg_cost_per_pack ?? item.cost_per_pack
  const [id] = await postMovements(tx, [{
    itemId: input.itemId, kind: 'adjustment', qtyUnits: input.qtyUnits, reasonCode: input.reasonCode,
    note: input.note ?? null, unitCost: unitCost === null ? null : Number(unitCost) / item.pack_size,
  }], opts)
  return id
}

export const defaultAdjustmentReasons: [string, string][] = [
  ['DAMAGED', 'Damaged'],
  ['EXPIRED', 'Expired'],
  ['THEFT', 'Theft or loss'],
  ['OWN_USE', 'Own use'],
  ['FOUND', 'Found stock'],
  ['COUNT', 'Count correction'],
  ['SAMPLE', 'Free sample or bonus'],
  ['OTHER', 'Other'],
]
