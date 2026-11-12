import type { Tx } from '../db/index.js'
import { num } from '../db/index.js'
import { patientName } from './patients.js'
import { repeatsDue } from './rxreports.js'
import { bounds, shopToday } from './sales.js'
import { getSettings } from './settings.js'

/** The counts and lists on each module's home page. Read-only. */

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function today(tx: Tx) {
  const { timezone } = await getSettings(tx)
  const day = shopToday(timezone)
  return { day, ...(await bounds(tx, { from: day, to: day })) }
}

export interface RxHomeScript {
  id: string
  scriptNo: number | null
  at: Date
  patientName: string
  medicalAid: string | null
  items: number
  total: number
  /** draft, unpaid (dispensed, the patient's share not yet paid at the till), paid, owed, reversed */
  state: 'draft' | 'unpaid' | 'paid' | 'owed' | 'reversed'
}

export async function dispensaryHome(tx: Tx) {
  const t = await today(tx)
  const [c] = await tx`
    select
      (select count(*) from scripts where status = 'draft')::int as drafts,
      (select count(*) from owed_items o join script_lines l on l.id = o.script_line_id
        where o.cancelled_at is null
          and o.qty_units > coalesce((select sum(os.qty_units) from owed_supplies os where os.owed_item_id = o.id), 0))::int as owed,
      (select count(*) from scripts s
        where s.status = 'dispensed' and s.bill_medical_aid and s.medical_aid_id is not null and s.claim_total > 0
          and s.dispensed_at >= now() - interval '90 days'
          and not exists (select 1 from claim_batch_scripts b where b.script_id = s.id and b.kind = 'Request' and not b.test))::int as unclaimed`
  const repeats = (await repeatsDue(tx, { from: t.day, to: addDays(t.day, 6) })).length
  const rows = await tx`
    select s.id, s.script_no, s.status, coalesce(s.dispensed_at, s.created_at) as at, s.total, s.patient_total,
           p.title, p.first_names, p.surname, ma.name as aid_name,
           (select count(*) from script_lines l where l.script_id = s.id)::int as items,
           exists (select 1 from sales x where x.script_id = s.id) as paid,
           exists (select 1 from owed_items o join script_lines l on l.id = o.script_line_id
                    where l.script_id = s.id and o.cancelled_at is null
                      and o.qty_units > coalesce((select sum(os.qty_units) from owed_supplies os where os.owed_item_id = o.id), 0)) as owes
      from scripts s join patients p on p.id = s.patient_id left join medical_aids ma on ma.id = s.medical_aid_id
     where s.status = 'draft'
        or (s.dispensed_at >= ${t.start} and s.dispensed_at < ${t.end})
     order by coalesce(s.dispensed_at, s.created_at) desc
     limit 40`
  const scripts: RxHomeScript[] = rows.map((r) => ({
    id: r.id, scriptNo: r.script_no, at: r.at, patientName: patientName(r as any), medicalAid: r.aid_name,
    items: r.items, total: num(r.total),
    state: r.status === 'draft' ? 'draft' : r.status === 'reversed' ? 'reversed'
      : !r.paid && num(r.patient_total) > 0 ? 'unpaid' : r.owes ? 'owed' : 'paid',
  }))
  const dispensedToday = rows.filter((r) => r.status === 'dispensed' && r.at >= t.start).length
  return { drafts: c.drafts as number, owed: c.owed as number, repeats, unclaimed: c.unclaimed as number, dispensedToday, scripts }
}

export interface StockHomeItem { id: string; stockCode: string; description: string; packSize: number; onHand: number; minUnits: number | null; sold90: number; costPerPack: number | null }

export async function stockHome(tx: Tx) {
  const [c] = await tx`
    with sold as (
      select item_id, -sum(qty_units) as units from stock_movements
       where kind in ('sale','dispense','sale_return') and occurred_at >= now() - interval '90 days' group by item_id)
    select
      (select count(*) from items i join stock_levels l on l.item_id = i.id join sold on sold.item_id = i.id
        where i.status = 'active' and l.on_hand_units <= 0 and sold.units > 0)::int as out_selling,
      (select count(*) from items i join stock_levels l on l.item_id = i.id
        where i.status = 'active' and l.min_units is not null and l.on_hand_units <= l.min_units)::int as below_min,
      (select count(*) from items i join stock_levels l on l.item_id = i.id where l.on_hand_units < 0)::int as negative,
      (select coalesce(sum(greatest(l.on_hand_units, 0)::numeric / i.pack_size * coalesce(i.avg_cost_per_pack, i.cost_per_pack, 0)), 0)
         from items i join stock_levels l on l.item_id = i.id where i.status = 'active') as value_cost`
  const rows = await tx`
    with sold as (
      select item_id, -sum(qty_units) as units from stock_movements
       where kind in ('sale','dispense','sale_return') and occurred_at >= now() - interval '90 days' group by item_id)
    select i.id, i.stock_code, i.description, i.pack_size, l.on_hand_units, l.min_units, sold.units as sold, i.cost_per_pack
      from items i join stock_levels l on l.item_id = i.id join sold on sold.item_id = i.id
     where i.status = 'active' and sold.units > 0
       and (l.on_hand_units <= 0 or (l.min_units is not null and l.on_hand_units <= l.min_units))
     order by (l.on_hand_units <= 0) desc, sold.units desc
     limit 40`
  const items: StockHomeItem[] = rows.map((r) => ({
    id: r.id, stockCode: r.stock_code, description: r.description, packSize: r.pack_size, onHand: r.on_hand_units,
    minUnits: r.min_units === null ? null : num(r.min_units), sold90: num(r.sold), costPerPack: r.cost_per_pack === null ? null : num(r.cost_per_pack),
  }))
  return { outSelling: c.out_selling as number, belowMin: c.below_min as number, negative: c.negative as number, valueCost: num(c.value_cost), items }
}

export interface SaleRow { id: string; saleNo: number; at: Date; kind: string; total: number; who: string | null; scriptNo: number | null }

export async function salesHome(tx: Tx) {
  const t = await today(tx)
  const [c] = await tx`
    select coalesce(sum(total), 0) as total, coalesce(sum(total - vat - cost), 0) as gp, count(*) filter (where kind = 'sale')::int as n
      from sales where occurred_at >= ${t.start} and occurred_at < ${t.end}`
  const [r] = await tx`
    select (select count(*) from till_runs where status = 'open')::int as open_runs,
           (select count(*) from customer_accounts a
             where a.active and a.credit_limit is not null
               and (select coalesce(sum(e.amount), 0) from account_entries e where e.account_id = a.id) > a.credit_limit)::int as over_limit,
           (select count(*) from scripts s where s.status = 'dispensed' and s.patient_total > 0
               and s.dispensed_at >= now() - interval '30 days'
               and not exists (select 1 from sales x where x.script_id = s.id))::int as scripts_unpaid`
  const rows = await tx`
    select x.id, x.sale_no, x.occurred_at, x.kind, x.total, u.name, s.script_no
      from sales x left join users u on u.id = x.user_id left join scripts s on s.id = x.script_id
     where x.occurred_at >= ${t.start} and x.occurred_at < ${t.end}
     order by x.occurred_at desc limit 40`
  const sales: SaleRow[] = rows.map((x) => ({ id: x.id, saleNo: x.sale_no, at: x.occurred_at, kind: x.kind, total: num(x.total), who: x.name, scriptNo: x.script_no }))
  return {
    salesToday: num(c.total), gpToday: num(c.gp), salesCount: c.n as number,
    openRuns: r.open_runs as number, overLimit: r.over_limit as number, scriptsUnpaid: r.scripts_unpaid as number, sales,
  }
}

export interface AuditRow { at: Date; who: string | null; action: string; entity: string; entityId: string | null }

export async function recentAudit(tx: Tx, limit = 40): Promise<AuditRow[]> {
  const rows = await tx`
    select a.at, u.name, a.action, a.entity, a.entity_id from audit_log a left join users u on u.id = a.user_id
     where a.entity <> 'login'
     order by a.at desc limit ${limit}`
  return rows.map((a) => ({ at: a.at, who: a.name, action: a.action, entity: a.entity, entityId: a.entity_id }))
}
