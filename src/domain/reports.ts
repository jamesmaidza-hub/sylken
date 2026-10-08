import type { Tx } from '../db/index.js'
import { num } from '../db/index.js'

export async function negativeStock(tx: Tx) {
  return tx`
    select i.id, i.stock_code, i.description, i.pack_size, s.on_hand_units
      from stock_levels s join items i on i.id = s.item_id
     where s.on_hand_units < 0 order by s.on_hand_units`
}

/** Stock value at average cost (excl VAT) and at retail (incl VAT). */
export async function stockValuation(tx: Tx) {
  const [r] = await tx`
    select count(*) filter (where s.on_hand_units > 0) as lines,
           coalesce(sum(greatest(s.on_hand_units, 0) * coalesce(i.avg_cost_per_pack, i.cost_per_pack, 0) / i.pack_size), 0) as cost_value,
           coalesce(sum(greatest(s.on_hand_units, 0) * i.retail_per_pack / i.pack_size), 0) as retail_value,
           count(*) filter (where s.on_hand_units > 0 and coalesce(i.avg_cost_per_pack, i.cost_per_pack) is null) as lines_without_cost
      from stock_levels s join items i on i.id = s.item_id`
  return { lines: Number(r.lines), costValue: num(r.cost_value), retailValue: num(r.retail_value), linesWithoutCost: Number(r.lines_without_cost) }
}

/** Items holding stock that haven't sold in the given number of months. */
export async function dormantStock(tx: Tx, months = 6, asOf = new Date()) {
  const since = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - months, 1))
  return tx`
    select i.id, i.stock_code, i.description, i.pack_size, s.on_hand_units,
           s.on_hand_units * coalesce(i.avg_cost_per_pack, i.cost_per_pack, 0) / i.pack_size as cost_value
      from stock_levels s join items i on i.id = s.item_id
     where s.on_hand_units > 0
       and not exists (select 1 from usage_history u where u.item_id = i.id and u.period >= ${since} and u.sold_units > 0)
       and not exists (select 1 from stock_movements m where m.item_id = i.id and m.kind in ('sale','dispense') and m.occurred_at >= ${since})
     order by cost_value desc`
}

export async function itemMovements(tx: Tx, itemId: string, limit = 200) {
  return tx`
    select m.id, m.kind, m.qty_units, m.unit_cost, m.unit_retail, m.reason_code, m.ref_type, m.ref_id, m.note, m.occurred_at,
           u.name as user_name,
           sum(m.qty_units) over (order by m.occurred_at, m.recorded_at, m.id) as balance
      from stock_movements m left join users u on u.id = m.user_id
     where m.item_id = ${itemId}
     order by m.occurred_at desc, m.recorded_at desc, m.id desc
     limit ${limit}`
}

export async function adjustmentsReport(tx: Tx, from: Date, to: Date) {
  return tx`
    select m.occurred_at, i.stock_code, i.description, i.pack_size, m.kind, m.qty_units, m.reason_code, r.label as reason,
           m.qty_units * coalesce(m.unit_cost, 0) as value, m.note, u.name as user_name
      from stock_movements m join items i on i.id = m.item_id
      left join adjustment_reasons r on r.code = m.reason_code
      left join users u on u.id = m.user_id
     where m.kind in ('adjustment','stocktake') and m.occurred_at >= ${from} and m.occurred_at < ${to}
     order by m.occurred_at desc`
}

/** Items selling below cost or below a GP threshold, using GP on the price excl VAT. */
export async function gpExceptions(tx: Tx, minGpPct = 10) {
  return tx`
    select i.id, i.stock_code, i.description, i.cost_per_pack, i.retail_per_pack,
           round(((i.retail_per_pack / (1 + coalesce(i.vat_rate, ts.vat_rate)) - i.cost_per_pack)
                  / nullif(i.retail_per_pack / (1 + coalesce(i.vat_rate, ts.vat_rate)), 0) * 100)::numeric, 1) as gp_pct
      from items i cross join tenant_settings ts
     where i.status = 'active' and i.cost_per_pack is not null and i.retail_per_pack > 0
       and (i.retail_per_pack / (1 + coalesce(i.vat_rate, ts.vat_rate)) - i.cost_per_pack)
           < i.retail_per_pack / (1 + coalesce(i.vat_rate, ts.vat_rate)) * ${minGpPct / 100}
     order by gp_pct`
}

export async function quarantined(tx: Tx) {
  return tx`select id, stock_code, description, cost_per_pack, retail_per_pack, status_reason from items where status = 'quarantined' order by status_reason, description`
}

export async function counts(tx: Tx) {
  const [r] = await tx`
    select count(*) filter (where status = 'active') as active, count(*) filter (where status = 'dormant') as dormant,
           count(*) filter (where status = 'quarantined') as quarantined, count(*) as total
      from items`
  return { active: Number(r.active), dormant: Number(r.dormant), quarantined: Number(r.quarantined), total: Number(r.total) }
}
