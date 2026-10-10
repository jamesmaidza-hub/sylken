import type { Tx } from '../db/index.js'
import { num, numOrNull } from '../db/index.js'
import { doctorName, patientName } from './patients.js'
import { bounds, shopToday, type DayRange } from './sales.js'
import { getSettings } from './settings.js'

/**
 * Dispensary reports. Every one is read from dispensed scripts (reversed scripts count only in
 * the reversals report), over trading days in the shop's time zone, both ends included. Values
 * are what was charged on the script, incl VAT; cost and GP are excl VAT.
 */

const docName = (r: any, p = 'doc_') =>
  r[`${p}surname`] ? doctorName({ title: r[`${p}title`], initials: r[`${p}initials`], surname: r[`${p}surname`] }) : null

const gpPct = (excl: number, cost: number) => (excl ? Math.round(((excl - cost) / excl) * 1000) / 10 : null)

// ---------------------------------------------------------------- drug usage

export interface DrugUsageRow {
  itemId: string; stockCode: string; nappiCode: string | null; description: string; schedule: number | null; packSize: number
  scripts: number; patients: number; units: number; total: number; excl: number; cost: number; gp: number; gpPct: number | null
}

/** What was dispensed per item: on how many scripts, for how many patients, how much and at what GP. */
export async function drugUsage(tx: Tx, range: DayRange, opts: { schedule?: number; q?: string } = {}): Promise<DrugUsageRow[]> {
  const b = await bounds(tx, range)
  const rows = await tx`
    select i.id, i.stock_code, i.nappi_code, i.description, i.schedule, i.pack_size,
           count(distinct s.id) as scripts, count(distinct s.patient_id) as patients, sum(l.qty_units) as units,
           sum(l.line_total) as total, sum(l.line_total - l.line_vat) as excl, sum(coalesce(l.unit_cost, 0) * l.qty_units) as cost
      from script_lines l join scripts s on s.id = l.script_id join items i on i.id = l.item_id
     where s.status = 'dispensed' and s.dispensed_at >= ${b.start} and s.dispensed_at < ${b.end}
       ${opts.schedule !== undefined ? tx`and i.schedule = ${opts.schedule}` : tx``}
       ${opts.q ? tx`and (upper(i.description) like ${'%' + opts.q.toUpperCase() + '%'} or upper(i.stock_code) = ${opts.q.toUpperCase()})` : tx``}
     group by i.id
     order by sum(l.line_total) desc, i.description`
  return rows.map((r) => {
    const excl = num(r.excl), cost = Math.round(num(r.cost) * 100) / 100
    return {
      itemId: r.id, stockCode: r.stock_code, nappiCode: r.nappi_code, description: r.description, schedule: r.schedule, packSize: r.pack_size,
      scripts: Number(r.scripts), patients: Number(r.patients), units: Number(r.units), total: num(r.total), excl, cost,
      gp: Math.round((excl - cost) * 100) / 100, gpPct: gpPct(excl, cost),
    }
  })
}

// ---------------------------------------------------------------- script analysis

export type AnalysisBy = 'day' | 'aid' | 'doctor' | 'dispenser'

export interface AnalysisRow {
  key: string; scripts: number; newScripts: number; repeats: number; patients: number; lines: number
  total: number; claim: number; patientShare: number; excl: number; cost: number; gp: number; gpPct: number | null; perScript: number
}

/**
 * Dispensed scripts counted and valued, grouped by day, medical aid, doctor or dispenser.
 * "Private" is scripts not billed to a medical aid.
 */
export async function scriptAnalysis(tx: Tx, range: DayRange, by: AnalysisBy) {
  const b = await bounds(tx, range)
  const rows = await tx`
    select s.id, s.patient_id, s.repeat_of, s.total, s.claim_total, s.patient_total, s.vat,
           to_char(s.dispensed_at at time zone ${b.timezone}, 'YYYY-MM-DD') as day,
           ma.name as aid_name, d.title as doc_title, d.initials as doc_initials, d.surname as doc_surname, u.name as dispenser,
           (select count(*) from script_lines l where l.script_id = s.id) as lines,
           (select coalesce(sum(coalesce(l.unit_cost, 0) * l.qty_units), 0) from script_lines l where l.script_id = s.id) as cost
      from scripts s left join medical_aids ma on ma.id = s.medical_aid_id left join doctors d on d.id = s.doctor_id
      left join users u on u.id = s.dispensed_by
     where s.status = 'dispensed' and s.dispensed_at >= ${b.start} and s.dispensed_at < ${b.end}`
  const keyOf = (r: any): string =>
    by === 'day' ? r.day : by === 'aid' ? (r.aid_name ?? 'Private') : by === 'doctor' ? (docName(r) ?? 'No doctor') : (r.dispenser ?? 'Unknown')
  const groups = new Map<string, { rows: any[]; patients: Set<string> }>()
  for (const r of rows) {
    const k = keyOf(r)
    const g = groups.get(k) ?? { rows: [], patients: new Set() }
    g.rows.push(r); g.patients.add(r.patient_id)
    groups.set(k, g)
  }
  const sum = (rs: any[], f: (r: any) => number) => Math.round(rs.reduce((a, r) => a + f(r), 0) * 100) / 100
  const make = (key: string, rs: any[], patients: number): AnalysisRow => {
    const total = sum(rs, (r) => num(r.total)), excl = sum(rs, (r) => num(r.total) - num(r.vat)), cost = sum(rs, (r) => num(r.cost))
    const newScripts = rs.filter((r) => !r.repeat_of).length
    return {
      key, scripts: rs.length, newScripts, repeats: rs.length - newScripts, patients, lines: rs.reduce((a, r) => a + Number(r.lines), 0),
      total, claim: sum(rs, (r) => num(r.claim_total)), patientShare: sum(rs, (r) => num(r.patient_total)), excl, cost,
      gp: Math.round((excl - cost) * 100) / 100, gpPct: gpPct(excl, cost), perScript: rs.length ? Math.round((total / rs.length) * 100) / 100 : 0,
    }
  }
  const out = [...groups].map(([k, g]) => make(k, g.rows, g.patients.size))
  out.sort(by === 'day' ? (a, b) => a.key.localeCompare(b.key) : (a, b) => b.total - a.total || a.key.localeCompare(b.key))
  return { rows: out, totals: make('Total', rows as any[], new Set(rows.map((r) => r.patient_id)).size) }
}

// ---------------------------------------------------------------- patients

export interface PatientRow {
  id: string; name: string; idNo: string | null; dateOfBirth: string | null; sex: string | null; phone: string | null
  medicalAid: string | null; memberNo: string | null; dependantCode: string | null; doctor: string | null; allergies: string | null
  scripts: number; value: number; lastVisit: Date | null
}

const patientRows = (rows: any[]): PatientRow[] => rows.map((r) => ({
  id: r.id, name: patientName(r), idNo: r.id_no, dateOfBirth: r.dob, sex: r.sex, phone: r.phone ?? r.mm_phone ?? null,
  medicalAid: r.aid_name, memberNo: r.member_no, dependantCode: r.dep_code, doctor: docName(r), allergies: r.allergies,
  scripts: Number(r.scripts ?? 0), value: num(r.value ?? 0), lastVisit: r.last_visit ?? null,
}))

const patientBase = (tx: Tx, b: { start: Date; end: Date }) => tx`
  select p.id, p.title, p.first_names, p.surname, p.id_no, p.date_of_birth::text as dob, p.sex, p.phone, mm.phone as mm_phone,
         ma.name as aid_name, coalesce(mm.member_no, p.member_no) as member_no,
         coalesce(p.dependant_code, case when p.medical_aid_id is not null then '00' end) as dep_code,
         d.title as doc_title, d.initials as doc_initials, d.surname as doc_surname,
         (select string_agg(f.text, ', ' order by f.text) from patient_flags f where f.patient_id = p.id and f.kind = 'allergy' and f.removed_at is null) as allergies,
         st.scripts, st.value, lv.last_visit
    from patients p
    left join patients mm on mm.id = p.main_member_id
    left join medical_aids ma on ma.id = coalesce(mm.medical_aid_id, p.medical_aid_id)
    left join doctors d on d.id = p.doctor_id
    left join lateral (select count(*) as scripts, sum(s.total) as value from scripts s
                        where s.patient_id = p.id and s.status = 'dispensed' and s.dispensed_at >= ${b.start} and s.dispensed_at < ${b.end}) st on true
    left join lateral (select max(s.dispensed_at) as last_visit from scripts s where s.patient_id = p.id and s.status = 'dispensed') lv on true`

/** Patients with what they had dispensed in the range; by default only those seen in it. */
export async function patientList(tx: Tx, range: DayRange, opts: { all?: boolean; aidId?: string } = {}): Promise<PatientRow[]> {
  const b = await bounds(tx, range)
  const rows = await tx`
    select * from (${patientBase(tx, b)}
     where p.active
       ${opts.aidId === 'private' ? tx`and coalesce(mm.medical_aid_id, p.medical_aid_id) is null` : opts.aidId ? tx`and coalesce(mm.medical_aid_id, p.medical_aid_id) = ${opts.aidId}` : tx``}
    ) x
    ${opts.all ? tx`` : tx`where x.scripts > 0`}
    order by upper(x.surname), upper(coalesce(x.first_names, ''))`
  return patientRows(rows)
}

/** Patients whose last dispensed script fell in the range, longest gone first, to follow up. */
export async function lastVisit(tx: Tx, range: DayRange): Promise<(PatientRow & { lastScriptNo: number | null; lastItems: string | null })[]> {
  const b = await bounds(tx, range)
  const rows = await tx`
    select x.*, ls.script_no as last_script_no, ls.items as last_items from (${patientBase(tx, { start: new Date(0), end: new Date('9999-01-01') })}
     where p.active) x
     left join lateral (select s.script_no, (select string_agg(i.description, '; ' order by l.line_no) from script_lines l join items i on i.id = l.item_id
                                             where l.script_id = s.id) as items
                          from scripts s where s.patient_id = x.id and s.status = 'dispensed' order by s.dispensed_at desc limit 1) ls on true
    where x.last_visit >= ${b.start} and x.last_visit < ${b.end}
    order by x.last_visit, upper(x.surname)`
  return patientRows(rows).map((p, i) => ({ ...p, lastScriptNo: rows[i].last_script_no, lastItems: rows[i].last_items }))
}

// ---------------------------------------------------------------- repeats not recently filled

export interface RepeatDue {
  scriptId: string; scriptNo: number; patientId: string; patient: string; phone: string | null; medicalAid: string | null
  stockCode: string; description: string; directions: string; qtyUnits: number; packSize: number
  repeatsLeft: number; lastFilled: string; due: string; daysOverdue: number; expires: string
}

/**
 * Repeats still owed to patients that are due (last supply plus its days' supply) inside the
 * range and have not been collected. Repeats past the shop's validity period are left out.
 */
export async function repeatsDue(tx: Tx, range: DayRange): Promise<RepeatDue[]> {
  await bounds(tx, range)                                   // checks the dates
  const s = await getSettings(tx)
  const today = shopToday(s.timezone)
  const rows = await tx`
    with o as (
      select l.id, l.qty_units, l.directions, l.repeats, coalesce(l.supply_days, ${s.defaultSupplyDays}) as days,
             s.id as script_id, s.script_no, s.rx_date, s.patient_id, s.dispensed_at, i.stock_code, i.description, i.pack_size,
             (select count(*) from script_lines rl join scripts rs on rs.id = rl.script_id
               where rl.repeat_of_line = l.id and rs.status = 'dispensed')::int as used,
             (select max(rs.dispensed_at) from script_lines rl join scripts rs on rs.id = rl.script_id
               where rl.repeat_of_line = l.id and rs.status = 'dispensed') as last_repeat
        from script_lines l join scripts s on s.id = l.script_id join items i on i.id = l.item_id
       where s.status = 'dispensed' and s.repeat_of is null and l.repeats > 0
    ), d as (
      select o.*, o.repeats - o.used as left_,
             to_char(greatest(o.dispensed_at, coalesce(o.last_repeat, o.dispensed_at)) at time zone ${s.timezone}, 'YYYY-MM-DD') as last_filled,
             ((greatest(o.dispensed_at, coalesce(o.last_repeat, o.dispensed_at)) at time zone ${s.timezone})::date + o.days) as due,
             (o.rx_date + ${s.repeatValidDays}::int) as expires
        from o where o.repeats - o.used > 0
    )
    select d.*, d.due::text as due_s, d.expires::text as expires_s, (${today}::date - d.due) as overdue,
           p.title, p.first_names, p.surname, coalesce(p.phone, mm.phone) as phone, ma.name as aid_name
      from d join patients p on p.id = d.patient_id left join patients mm on mm.id = p.main_member_id
      left join medical_aids ma on ma.id = coalesce(mm.medical_aid_id, p.medical_aid_id)
     where d.due >= ${range.from}::date and d.due <= ${range.to}::date and d.expires >= ${today}::date and p.active
     order by d.due, upper(p.surname), d.script_no`
  return rows.map((r) => ({
    scriptId: r.script_id, scriptNo: r.script_no, patientId: r.patient_id, patient: patientName(r as any), phone: r.phone, medicalAid: r.aid_name,
    stockCode: r.stock_code, description: r.description, directions: r.directions, qtyUnits: r.qty_units, packSize: r.pack_size,
    repeatsLeft: r.left_, lastFilled: r.last_filled, due: r.due_s, daysOverdue: Number(r.overdue), expires: r.expires_s,
  }))
}

// ---------------------------------------------------------------- price changes

export interface PriceChange {
  at: Date; itemId: string; stockCode: string; description: string; packSize: number
  oldCost: number | null; newCost: number | null; oldRetail: number | null; newRetail: number | null; changePct: number | null
  source: string; by: string | null
}

export const priceSources: Record<string, string> = { receipt: 'Invoice received', manual: 'Changed by hand', reprice: 'Re-priced from cost', import: 'Imported' }

/** Every price change in the range, with the price before and after. */
export async function priceChanges(tx: Tx, range: DayRange, opts: { source?: string; dispensedOnly?: boolean } = {}): Promise<PriceChange[]> {
  const b = await bounds(tx, range)
  const rows = await tx`
    with h as (
      select ph.*, lag(ph.cost_per_pack) over w as old_cost, lag(ph.retail_per_pack) over w as old_retail, row_number() over w as n
        from price_history ph window w as (partition by ph.item_id order by ph.effective_from, ph.id)
    )
    select h.effective_from, h.cost_per_pack, h.retail_per_pack, h.old_cost, h.old_retail, h.source,
           i.id as item_id, i.stock_code, i.description, i.pack_size, u.name as by_name
      from h join items i on i.id = h.item_id left join users u on u.id = h.user_id
     where h.n > 1 and h.effective_from >= ${b.start} and h.effective_from < ${b.end}
       and (h.cost_per_pack is distinct from h.old_cost or h.retail_per_pack is distinct from h.old_retail)
       ${opts.source ? tx`and h.source = ${opts.source}` : tx``}
       ${opts.dispensedOnly ? tx`and exists (select 1 from script_lines l where l.item_id = i.id)` : tx``}
     order by h.effective_from desc, i.description`
  return rows.map((r) => {
    const oldRetail = numOrNull(r.old_retail), newRetail = numOrNull(r.retail_per_pack)
    return {
      at: r.effective_from, itemId: r.item_id, stockCode: r.stock_code, description: r.description, packSize: r.pack_size,
      oldCost: numOrNull(r.old_cost), newCost: numOrNull(r.cost_per_pack), oldRetail, newRetail,
      changePct: oldRetail && newRetail !== null ? Math.round(((newRetail - oldRetail) / oldRetail) * 1000) / 10 : null,
      source: r.source, by: r.by_name,
    }
  })
}

// ---------------------------------------------------------------- reversed scripts

/** Scripts reversed in the range, with why and by whom. */
export async function reversedScripts(tx: Tx, range: DayRange) {
  const b = await bounds(tx, range)
  const rows = await tx`
    select s.id, s.script_no, s.dispensed_at, s.reversed_at, s.reverse_reason, s.total, p.title, p.first_names, p.surname,
           du.name as dispensed_by, ru.name as reversed_by,
           (select string_agg(i.description || ' x' || l.qty_units, '; ' order by l.line_no) from script_lines l join items i on i.id = l.item_id
             where l.script_id = s.id) as items
      from scripts s join patients p on p.id = s.patient_id left join users du on du.id = s.dispensed_by left join users ru on ru.id = s.reversed_by
     where s.status = 'reversed' and s.reversed_at >= ${b.start} and s.reversed_at < ${b.end}
     order by s.reversed_at desc`
  return rows.map((r) => ({
    id: r.id as string, scriptNo: r.script_no as number, dispensedAt: r.dispensed_at as Date, reversedAt: r.reversed_at as Date,
    reason: r.reverse_reason as string | null, total: num(r.total), patient: patientName(r as any), items: r.items as string | null,
    dispensedBy: r.dispensed_by as string | null, reversedBy: r.reversed_by as string | null,
  }))
}
