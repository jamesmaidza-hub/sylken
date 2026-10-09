import type { Tx } from '../db/index.js'
import { num, numOrNull } from '../db/index.js'
import { DomainError } from './errors.js'
import { audit } from './items.js'
import { allergyHits, doctorName, expandDirections, getPatient, patientFlags, patientName, tenantId, type Patient, type PatientFlag } from './patients.js'
import { round2 } from './pricing.js'
import { getSettings, type Settings } from './settings.js'
import { postMovements } from './stock.js'
import { linePrice, nextNumber, vatIn } from './till.js'

/**
 * Scripts. A script is a draft while it is captured; dispensing it takes the stock, gives it a
 * script number and freezes it. A mistake after that is put right by reversing the script and
 * capturing it again. The patient's share is paid at the till by script number, and the medical
 * aid share is kept on the script for claims (stage 4).
 */

const isoDay = /^\d{4}-\d{2}-\d{2}$/
const icd10Pattern = /^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/

/** ICD-10 codes typed as "j06.9, Z76.9" become ["J06.9", "Z76.9"]; anything that isn't shaped like a code is refused. */
export function parseIcd10(raw: string | string[] | null | undefined): string[] {
  const parts = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,;]+/)).map((s) => s.trim().toUpperCase()).filter(Boolean)
  for (const p of parts) if (!icd10Pattern.test(p)) throw new DomainError(`${p} is not an ICD-10 code (like J06.9)`)
  if (parts.length > 4) throw new DomainError('up to four ICD-10 codes per line')
  return [...new Set(parts)]
}

/** A script line's price: the item at the shop's price for the units prescribed, plus the dispensing fee. */
export function priceLine(retailPerPack: number, packSize: number, qtyUnits: number, itemVatRate: number, fee: number, standardVat: number) {
  const itemTotal = linePrice(retailPerPack, packSize, qtyUnits)
  const f = round2(fee)
  return { itemTotal, fee: f, lineTotal: round2(itemTotal + f), vat: round2(vatIn(itemTotal, itemVatRate) + vatIn(f, standardVat)) }
}

// ---------------------------------------------------------------- drafts

export interface ScriptHeaderInput {
  patientId: string
  doctorId?: string | null
  rxDate: string
  billMedicalAid?: boolean
  note?: string | null
}

async function checkHeader(tx: Tx, h: ScriptHeaderInput, settings: Settings) {
  if (!isoDay.test(h.rxDate) || Number.isNaN(Date.parse(h.rxDate))) throw new DomainError('the script date must be a date')
  const [d] = await tx`select current_date + 1 > ${h.rxDate}::date as ok, ${h.rxDate}::date < current_date - ${settings.repeatValidDays * 2}::int as old`
  if (!d.ok) throw new DomainError('the script date is in the future')
  if (d.old) throw new DomainError('the script date is too far in the past')
  if (h.doctorId) {
    const [doc] = await tx`select id from doctors where id = ${h.doctorId}`
    if (!doc) throw new DomainError('unknown doctor', 'not_found', 404)
  }
}

export async function createDraft(tx: Tx, h: ScriptHeaderInput, userId?: string): Promise<string> {
  const settings = await getSettings(tx)
  const patient = await getPatient(tx, h.patientId)
  if (!patient) throw new DomainError('unknown patient', 'not_found', 404)
  if (!patient.active) throw new DomainError('this patient is marked inactive')
  await checkHeader(tx, h, settings)
  const [s] = await tx`
    insert into scripts (tenant_id, patient_id, doctor_id, rx_date, bill_medical_aid, note, created_by)
    values (${await tenantId(tx)}, ${h.patientId}, ${h.doctorId || patient.doctorId || null}, ${h.rxDate}, ${h.billMedicalAid ?? true},
            ${h.note?.trim() || null}, ${userId ?? null})
    returning id`
  return s.id as string
}

async function draft(tx: Tx, scriptId: string) {
  const [s] = await tx`select * from scripts where id = ${scriptId} for update`
  if (!s) throw new DomainError('unknown script', 'not_found', 404)
  if (s.status !== 'draft') throw new DomainError(`script ${s.script_no} is already dispensed; reverse it to make changes`, 'dispensed', 409)
  return s
}

export async function updateDraft(tx: Tx, scriptId: string, h: Omit<ScriptHeaderInput, 'patientId'>) {
  const s = await draft(tx, scriptId)
  if (s.repeat_of) throw new DomainError('a repeat keeps the doctor and date of the original script')
  await checkHeader(tx, { ...h, patientId: s.patient_id }, await getSettings(tx))
  await tx`update scripts set doctor_id = ${h.doctorId || null}, rx_date = ${h.rxDate}, bill_medical_aid = ${h.billMedicalAid ?? true},
                              note = ${h.note?.trim() || null} where id = ${scriptId}`
}

export async function discardDraft(tx: Tx, scriptId: string, userId?: string) {
  const s = await draft(tx, scriptId)
  await tx`delete from scripts where id = ${scriptId}`
  await audit(tx, userId, 'discard', 'script', scriptId, { patientId: s.patient_id })
  return s.patient_id as string
}

export interface LineInput {
  itemId: string
  qtyUnits: number
  supplyUnits?: number | null      // handed over now; default all of it
  directions: string               // a direction code or text
  supplyDays?: number | null
  repeats?: number | null
  icd10?: string | string[] | null
  noClaim?: boolean
}

export async function addLine(tx: Tx, scriptId: string, l: LineInput) {
  const s = await draft(tx, scriptId)
  if (s.repeat_of) throw new DomainError('a repeat supplies the lines of the original script; start a new script for anything else')
  const settings = await getSettings(tx)
  const [item] = await tx`select id, status, description from items where id = ${l.itemId}`
  if (!item) throw new DomainError('unknown item', 'not_found', 404)
  if (!Number.isInteger(l.qtyUnits) || l.qtyUnits <= 0) throw new DomainError('quantity must be a whole number of units above zero')
  if (l.qtyUnits > 100_000) throw new DomainError('that quantity is too large')
  const supply = l.supplyUnits ?? l.qtyUnits
  if (!Number.isInteger(supply) || supply < 0 || supply > l.qtyUnits) throw new DomainError('the quantity given now must be between 0 and the quantity prescribed')
  const directions = await expandDirections(tx, l.directions)
  if (!directions) throw new DomainError('every line needs directions for the label')
  if (directions.length > 300) throw new DomainError('directions are too long for a label')
  const repeats = l.repeats ?? 0
  if (!Number.isInteger(repeats) || repeats < 0 || repeats > 12) throw new DomainError('repeats must be between 0 and 12')
  const days = l.supplyDays ?? settings.defaultSupplyDays
  if (!Number.isInteger(days) || days <= 0 || days > 366) throw new DomainError('supply days must be between 1 and 366')
  const icd10 = parseIcd10(l.icd10)
  const [n] = await tx`select coalesce(max(line_no), 0) + 1 as n from script_lines where script_id = ${scriptId}`
  await tx`
    insert into script_lines (tenant_id, script_id, line_no, item_id, qty_units, supply_units, directions, supply_days, repeats, icd10, no_claim)
    values (${await tenantId(tx)}, ${scriptId}, ${n.n}, ${l.itemId}, ${l.qtyUnits}, ${supply}, ${directions}, ${days}, ${repeats},
            ${icd10}, ${l.noClaim ?? false})`
  await reprice(tx, scriptId)
}

export async function removeLine(tx: Tx, scriptId: string, lineId: string) {
  await draft(tx, scriptId)
  const [l] = await tx`delete from script_lines where id = ${lineId} and script_id = ${scriptId} returning id`
  if (!l) throw new DomainError('that line is not on this script', 'not_found', 404)
  await reprice(tx, scriptId)
}

/** Price every line of a draft at today's prices and fee, and total the script. */
async function reprice(tx: Tx, scriptId: string) {
  const settings = await getSettings(tx)
  const lines = await tx`
    select l.id, l.qty_units, i.retail_per_pack, i.pack_size, i.vat_rate, i.avg_cost_per_pack, i.cost_per_pack, i.nappi_code
      from script_lines l join items i on i.id = l.item_id where l.script_id = ${scriptId}`
  for (const l of lines) {
    const rate = numOrNull(l.vat_rate) ?? settings.vatRate
    const p = priceLine(num(l.retail_per_pack), l.pack_size, l.qty_units, rate, settings.dispensingFee, settings.vatRate)
    const packCost = numOrNull(l.avg_cost_per_pack) ?? numOrNull(l.cost_per_pack)
    await tx`update script_lines set item_total = ${p.itemTotal}, fee = ${p.fee}, line_total = ${p.lineTotal}, vat_rate = ${rate},
                                     line_vat = ${p.vat}, unit_cost = ${packCost === null ? null : packCost / l.pack_size}, nappi_code = ${l.nappi_code}
              where id = ${l.id}`
  }
  await tx`
    update scripts s set total = t.total, vat = t.vat, cost = t.cost, fees = t.fees
      from (select coalesce(sum(line_total), 0) as total, coalesce(sum(line_vat), 0) as vat,
                   coalesce(sum(qty_units * coalesce(unit_cost, 0)), 0) as cost, coalesce(sum(fee), 0) as fees
              from script_lines where script_id = ${scriptId}) t
     where s.id = ${scriptId}`
}

// ---------------------------------------------------------------- reading a script

export interface ScriptLine {
  id: string
  lineNo: number
  itemId: string
  stockCode: string
  description: string
  packSize: number
  schedule: number | null
  nappiCode: string | null
  itemStatus: string
  onHandUnits: number
  qtyUnits: number
  supplyUnits: number
  owedUnits: number                // still owed now (after later supplies and cancellations)
  directions: string
  supplyDays: number | null
  repeats: number
  repeatsLeft: number | null       // on an original script's line
  repeatOfLine: string | null
  icd10: string[]
  noClaim: boolean
  itemTotal: number
  fee: number
  lineTotal: number
  vat: number
  unitCost: number | null
}

export interface Script {
  id: string
  scriptNo: number | null
  status: 'draft' | 'dispensed' | 'reversed'
  patient: Patient
  doctorId: string | null
  doctorName: string | null
  doctorPracticeNo: string | null
  rxDate: string
  repeatOf: { id: string; scriptNo: number | null } | null
  repeatNo: number | null          // 1 for the first repeat, ...
  billMedicalAid: boolean
  medicalAidName: string | null    // as dispensed (or as it would be, on a draft)
  memberNo: string | null
  dependantCode: string | null
  total: number
  vat: number
  cost: number
  fees: number
  claimTotal: number
  patientTotal: number
  note: string | null
  createdBy: string | null
  createdAt: Date
  dispensedBy: string | null
  dispensedAt: Date | null
  reversedBy: string | null
  reversedAt: Date | null
  reverseReason: string | null
  lines: ScriptLine[]
  sales: { id: string; saleNo: number; kind: string; total: number; occurredAt: Date }[]
  paid: number                     // net of refunds, at the till
  repeats: { id: string; scriptNo: number | null; status: string; dispensedAt: Date | null }[]
}

/** How the script's total splits between the medical aid and the patient. */
export function splitClaim(lines: { lineTotal: number; noClaim: boolean }[], billAid: boolean) {
  const total = round2(lines.reduce((a, l) => a + l.lineTotal, 0))
  if (!billAid) return { claimTotal: 0, patientTotal: total }
  const claimTotal = round2(lines.filter((l) => !l.noClaim).reduce((a, l) => a + l.lineTotal, 0))
  return { claimTotal, patientTotal: round2(total - claimTotal) }
}

export async function getScript(tx: Tx, id: string): Promise<Script | null> {
  const [s] = await tx`
    select s.*, s.rx_date::text as rx, d.surname as doc_surname, d.initials as doc_initials, d.title as doc_title, d.practice_no,
           ma.name as aid_name, o.script_no as orig_no,
           cu.name as created_by_name, du.name as dispensed_by_name, ru.name as reversed_by_name
      from scripts s left join doctors d on d.id = s.doctor_id left join medical_aids ma on ma.id = s.medical_aid_id
      left join scripts o on o.id = s.repeat_of
      left join users cu on cu.id = s.created_by left join users du on du.id = s.dispensed_by left join users ru on ru.id = s.reversed_by
     where s.id = ${id}`
  if (!s) return null
  const patient = (await getPatient(tx, s.patient_id))!
  const lines = await tx`
    select l.*, i.stock_code, i.description, i.pack_size, i.schedule, i.status as item_status, coalesce(sl.on_hand_units, 0) as on_hand,
           o.qty_units as owed_qty, o.cancelled_at as owed_cancelled,
           coalesce((select sum(os.qty_units) from owed_supplies os where os.owed_item_id = o.id), 0)::int as owed_supplied,
           (select count(*) from script_lines rl join scripts rs on rs.id = rl.script_id
             where rl.repeat_of_line = l.id and rs.status = 'dispensed')::int as repeats_used
      from script_lines l join items i on i.id = l.item_id left join stock_levels sl on sl.item_id = i.id
      left join owed_items o on o.script_line_id = l.id
     where l.script_id = ${id} order by l.line_no`
  const sales = await tx`select id, sale_no, kind, total, occurred_at from sales where script_id = ${id} order by occurred_at`
  const repeats = s.repeat_of
    ? []
    : await tx`select id, script_no, status, dispensed_at from scripts where repeat_of = ${id} order by created_at`
  let repeatNo: number | null = null
  if (s.repeat_of) {
    const [r] = await tx`select count(*)::int as n from scripts where repeat_of = ${s.repeat_of} and status = 'dispensed'
                           and (dispensed_at < ${s.dispensed_at ?? new Date('9999-01-01')} or id = ${s.id})`
    repeatNo = s.status === 'draft' ? r.n + 1 : r.n
  }
  const shaped: ScriptLine[] = lines.map((l) => ({
    id: l.id, lineNo: l.line_no, itemId: l.item_id, stockCode: l.stock_code, description: l.description, packSize: l.pack_size,
    schedule: l.schedule, nappiCode: l.nappi_code, itemStatus: l.item_status, onHandUnits: l.on_hand, qtyUnits: l.qty_units, supplyUnits: l.supply_units,
    owedUnits: l.owed_qty && !l.owed_cancelled ? l.owed_qty - l.owed_supplied : 0,
    directions: l.directions, supplyDays: l.supply_days, repeats: l.repeats,
    repeatsLeft: s.repeat_of ? null : Math.max(0, l.repeats - l.repeats_used), repeatOfLine: l.repeat_of_line,
    icd10: l.icd10, noClaim: l.no_claim, itemTotal: num(l.item_total), fee: num(l.fee), lineTotal: num(l.line_total), vat: num(l.line_vat),
    unitCost: numOrNull(l.unit_cost),
  }))
  // A draft shows the split it would get with the patient's medical aid as it stands now.
  const billAid = s.bill_medical_aid && (s.status === 'draft' ? !!patient.medicalAidId : !!s.medical_aid_id)
  const split = s.status === 'draft' ? splitClaim(shaped, billAid) : { claimTotal: num(s.claim_total), patientTotal: num(s.patient_total) }
  return {
    id: s.id, scriptNo: s.script_no, status: s.status, patient,
    doctorId: s.doctor_id, doctorName: s.doctor_id ? doctorName({ title: s.doc_title, initials: s.doc_initials, surname: s.doc_surname }) : null,
    doctorPracticeNo: s.practice_no, rxDate: s.rx, repeatOf: s.repeat_of ? { id: s.repeat_of, scriptNo: s.orig_no } : null, repeatNo,
    billMedicalAid: s.bill_medical_aid,
    medicalAidName: s.status === 'draft' ? (billAid ? patient.medicalAidName : null) : s.aid_name,
    memberNo: s.status === 'draft' ? (billAid ? patient.memberNo : null) : s.member_no,
    dependantCode: s.status === 'draft' ? (billAid ? patient.dependantCode : null) : s.dependant_code,
    total: num(s.total), vat: num(s.vat), cost: num(s.cost), fees: num(s.fees), ...split,
    note: s.note, createdBy: s.created_by_name, createdAt: s.created_at, dispensedBy: s.dispensed_by_name, dispensedAt: s.dispensed_at,
    reversedBy: s.reversed_by_name, reversedAt: s.reversed_at, reverseReason: s.reverse_reason,
    lines: shaped,
    sales: sales.map((x) => ({ id: x.id, saleNo: x.sale_no, kind: x.kind, total: num(x.total), occurredAt: x.occurred_at })),
    paid: round2(sales.reduce((a, x) => a + num(x.total), 0)),
    repeats: repeats.map((r) => ({ id: r.id, scriptNo: r.script_no, status: r.status, dispensedAt: r.dispensed_at })),
  }
}

// ---------------------------------------------------------------- checks before dispensing

export interface Warning {
  level: 'block' | 'confirm' | 'stock' | 'info'   // block: can't dispense; confirm: pharmacist ticks; stock: needs the stock override
  text: string
  lineNo?: number
}

/** Everything the pharmacist must see before a draft is dispensed. */
export function scriptWarnings(s: Script, flags: PatientFlag[], settings: Settings): Warning[] {
  const out: Warning[] = []
  const allergies = flags.filter((f) => f.kind === 'allergy').map((f) => f.text)
  if (!s.lines.length) out.push({ level: 'block', text: 'Add at least one item.' })
  if (allergies.length) out.push({ level: 'confirm', text: `Allergies on record: ${allergies.join(', ')}. Check every item against them.` })
  for (const f of flags.filter((x) => x.kind === 'alert')) out.push({ level: 'confirm', text: `Alert: ${f.text}` })
  if (s.patient.medicalAidMessage && s.medicalAidName) out.push({ level: 'info', text: `${s.medicalAidName}: ${s.patient.medicalAidMessage}` })
  const supplyByItem = new Map<string, { units: number; onHand: number; code: string }>()
  for (const l of s.lines) {
    for (const a of allergyHits(allergies, l.description)) {
      out.push({ level: 'confirm', lineNo: l.lineNo, text: `${l.description} may match the allergy "${a}".` })
    }
    if (l.itemStatus === 'quarantined') out.push({ level: 'block', lineNo: l.lineNo, text: `${l.stockCode} is quarantined; fix its record before dispensing it.` })
    if (l.itemStatus === 'discontinued') out.push({ level: 'info', lineNo: l.lineNo, text: `${l.stockCode} is marked discontinued.` })
    if (l.schedule !== null && settings.registerSchedules.includes(l.schedule)) {
      if (!s.doctorId) out.push({ level: 'block', lineNo: l.lineNo, text: `${l.description} is schedule ${l.schedule} and goes in the register, so the script needs its doctor.` })
      else out.push({ level: 'info', lineNo: l.lineNo, text: `${l.description} is schedule ${l.schedule}: it will be entered in the register.` })
    }
    if (l.supplyUnits < l.qtyUnits) out.push({ level: 'info', lineNo: l.lineNo, text: `${l.qtyUnits - l.supplyUnits} of ${l.description} will be owed to the patient.` })
    const agg = supplyByItem.get(l.itemId) ?? { units: 0, onHand: l.onHandUnits, code: l.stockCode }
    agg.units += l.supplyUnits
    supplyByItem.set(l.itemId, agg)
  }
  if (!settings.allowNegativeStock) {
    for (const a of supplyByItem.values()) {
      if (a.units > a.onHand) out.push({ level: 'stock', text: `${a.code}: giving ${a.units} units but stock shows ${a.onHand}.` })
    }
  }
  if (s.repeatOf) {
    const expires = addDays(s.rxDate, settings.repeatValidDays)
    if (expires < todayIso()) out.push({ level: 'block', text: `Repeats on this script ran out on ${expires}.` })
  } else if (s.rxDate < addDays(todayIso(), -settings.repeatValidDays)) {
    out.push({ level: 'confirm', text: `The script is dated ${s.rxDate}, more than ${settings.repeatValidDays} days ago.` })
  }
  return out
}

function todayIso() { return new Date().toISOString().slice(0, 10) }
export function addDays(iso: string, days: number) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------- dispensing

export interface DispenseOptions {
  confirmed?: boolean          // the pharmacist ticked that allergies and alerts were checked
  allowNegative?: boolean      // the pharmacist overrides a stock count that looks wrong
}

/** Dispense a draft: number it, take the stock, record what is owed, and freeze it. */
export async function dispenseScript(tx: Tx, scriptId: string, opts: DispenseOptions, userId?: string) {
  const row = await draft(tx, scriptId)
  await reprice(tx, scriptId)
  const settings = await getSettings(tx)
  const s = (await getScript(tx, scriptId))!
  const flags = await patientFlags(tx, s.patient.id)
  const warnings = scriptWarnings(s, flags, settings)
  const blocks = warnings.filter((w) => w.level === 'block')
  if (blocks.length) throw new DomainError(blocks.map((w) => w.text).join(' '), 'blocked', 409)
  if (warnings.some((w) => w.level === 'confirm') && !opts.confirmed) {
    throw new DomainError('Tick that you have checked the allergies and alerts, then dispense.', 'confirm', 409)
  }
  if (warnings.some((w) => w.level === 'stock') && !opts.allowNegative) {
    throw new DomainError(warnings.filter((w) => w.level === 'stock').map((w) => w.text).join(' ') + ' Count the shelf, or tick the stock override.', 'insufficient_stock', 409)
  }
  if (s.repeatOf) {
    for (const l of s.lines) {
      const [left] = await tx`
        select o.repeats - (select count(*) from script_lines rl join scripts rs on rs.id = rl.script_id
                             where rl.repeat_of_line = o.id and rs.status = 'dispensed')::int as left
          from script_lines o where o.id = ${l.repeatOfLine}`
      if (!left || left.left <= 0) throw new DomainError(`no repeats are left for ${l.description}`, 'no_repeats', 409)
    }
  }

  const billAid = row.bill_medical_aid && !!s.patient.medicalAidId
  const split = splitClaim(s.lines, billAid)
  const scriptNo = await nextNumber(tx, 'script')
  const dispensedAt = new Date()
  await tx`
    update scripts set status = 'dispensed', script_no = ${scriptNo}, dispensed_by = ${userId ?? null}, dispensed_at = ${dispensedAt},
           medical_aid_id = ${billAid ? s.patient.medicalAidId : null}, member_no = ${billAid ? s.patient.memberNo : null},
           dependant_code = ${billAid ? s.patient.dependantCode : null},
           claim_total = ${split.claimTotal}, patient_total = ${split.patientTotal}
     where id = ${scriptId}`
  await postMovements(tx, s.lines.filter((l) => l.supplyUnits > 0).map((l) => ({
    itemId: l.itemId, kind: 'dispense' as const, qtyUnits: -l.supplyUnits, unitCost: l.unitCost, unitRetail: l.itemTotal / l.qtyUnits,
    refType: 'script', refId: scriptId, occurredAt: dispensedAt,
  })), { userId, allowNegative: opts.allowNegative })
  const tid = await tenantId(tx)
  for (const l of s.lines.filter((x) => x.supplyUnits < x.qtyUnits)) {
    await tx`insert into owed_items (tenant_id, script_line_id, qty_units) values (${tid}, ${l.id}, ${l.qtyUnits - l.supplyUnits})`
  }
  await audit(tx, userId, 'dispense', 'script', scriptId, { scriptNo, total: s.total, overrideStock: !!opts.allowNegative, warnings: warnings.map((w) => w.text) })
  return { scriptNo }
}

/**
 * Reverse a dispensed script: the stock handed over comes back, anything still owed is
 * cancelled, and the script stays on record marked reversed. A script already paid at the
 * till must be refunded there first, so the money and the stock stay in step.
 */
export async function reverseScript(tx: Tx, scriptId: string, reason: string, userId?: string) {
  if (!reason.trim()) throw new DomainError('say why the script is being reversed')
  const [row] = await tx`select status, script_no from scripts where id = ${scriptId} for update`
  if (!row) throw new DomainError('unknown script', 'not_found', 404)
  if (row.status !== 'dispensed') throw new DomainError('only a dispensed script can be reversed')
  const s = (await getScript(tx, scriptId))!
  if (s.paid !== 0) throw new DomainError(`script ${s.scriptNo} was paid at the till; refund it there first`, 'paid', 409)
  if (s.repeats.some((r) => r.status === 'dispensed')) throw new DomainError('repeats of this script have been dispensed; reverse those first', 'has_repeats', 409)
  const back = await tx`
    select l.item_id, l.unit_cost, l.supply_units + coalesce((select sum(os.qty_units) from owed_supplies os where os.owed_item_id = o.id), 0)::int as units
      from script_lines l left join owed_items o on o.script_line_id = l.id
     where l.script_id = ${scriptId}`
  await postMovements(tx, back.filter((b) => b.units > 0).map((b) => ({
    itemId: b.item_id, kind: 'dispense' as const, qtyUnits: b.units, unitCost: numOrNull(b.unit_cost),
    refType: 'script', refId: scriptId, note: `reversal of script ${row.script_no}`,
  })), { userId })
  await tx`update owed_items set cancelled_at = now(), cancelled_by = ${userId ?? null}, cancel_reason = 'script reversed'
            where cancelled_at is null and script_line_id in (select id from script_lines where script_id = ${scriptId})`
  await tx`update scripts set status = 'reversed', reversed_by = ${userId ?? null}, reversed_at = now(), reverse_reason = ${reason.trim()} where id = ${scriptId}`
  await audit(tx, userId, 'reverse', 'script', scriptId, { scriptNo: row.script_no, reason: reason.trim() })
}

// ---------------------------------------------------------------- repeats

/**
 * Start the next repeat of a script as a draft holding the lines that still have repeats
 * left. Repeats are always counted against the original script.
 */
export async function startRepeat(tx: Tx, scriptId: string, userId?: string): Promise<string> {
  const [given] = await tx`select id, repeat_of from scripts where id = ${scriptId}`
  if (!given) throw new DomainError('unknown script', 'not_found', 404)
  const originalId = given.repeat_of ?? given.id
  const [open] = await tx`select id from scripts where repeat_of = ${originalId} and status = 'draft'`
  if (open) return open.id as string
  const orig = (await getScript(tx, originalId))!
  if (orig.status !== 'dispensed') throw new DomainError('repeats can only be given on a dispensed script')
  const settings = await getSettings(tx)
  const expires = addDays(orig.rxDate, settings.repeatValidDays)
  if (expires < todayIso()) throw new DomainError(`repeats on script ${orig.scriptNo} ran out on ${expires}`, 'expired', 409)
  const lines = orig.lines.filter((l) => (l.repeatsLeft ?? 0) > 0)
  if (!lines.length) throw new DomainError(`script ${orig.scriptNo} has no repeats left`, 'no_repeats', 409)
  const tid = await tenantId(tx)
  const [s] = await tx`
    insert into scripts (tenant_id, patient_id, doctor_id, rx_date, repeat_of, bill_medical_aid, created_by)
    values (${tid}, ${orig.patient.id}, ${orig.doctorId}, ${orig.rxDate}, ${originalId}, ${orig.billMedicalAid}, ${userId ?? null})
    returning id`
  for (const [n, l] of lines.entries()) {
    await tx`
      insert into script_lines (tenant_id, script_id, line_no, item_id, qty_units, supply_units, directions, supply_days, repeats,
                                repeat_of_line, icd10, no_claim)
      values (${tid}, ${s.id}, ${n + 1}, ${l.itemId}, ${l.qtyUnits}, ${l.qtyUnits}, ${l.directions}, ${l.supplyDays}, 0,
              ${l.id}, ${l.icd10}, ${l.noClaim})`
  }
  await reprice(tx, s.id)
  return s.id as string
}

/** On a repeat draft, change how much is handed over now (the rest is owed). */
export async function setSupply(tx: Tx, scriptId: string, lineId: string, supplyUnits: number) {
  await draft(tx, scriptId)
  const [l] = await tx`select qty_units from script_lines where id = ${lineId} and script_id = ${scriptId}`
  if (!l) throw new DomainError('that line is not on this script', 'not_found', 404)
  if (!Number.isInteger(supplyUnits) || supplyUnits < 0 || supplyUnits > l.qty_units) throw new DomainError('the quantity given now must be between 0 and the quantity on the script')
  await tx`update script_lines set supply_units = ${supplyUnits} where id = ${lineId}`
}

// ---------------------------------------------------------------- owed items

export interface OwedItem {
  id: string
  scriptId: string
  scriptNo: number
  patientId: string
  patientName: string
  phone: string | null
  itemId: string
  stockCode: string
  description: string
  onHandUnits: number
  owedUnits: number          // what was owed when dispensed
  suppliedUnits: number      // given since
  leftUnits: number
  since: Date
}

export async function listOwed(tx: Tx, opts: { patientId?: string } = {}): Promise<OwedItem[]> {
  const rows = await tx`
    select o.id, o.qty_units, o.created_at, s.id as script_id, s.script_no, p.id as patient_id, p.title, p.first_names, p.surname, p.phone,
           i.id as item_id, i.stock_code, i.description, coalesce(sl.on_hand_units, 0) as on_hand,
           coalesce((select sum(os.qty_units) from owed_supplies os where os.owed_item_id = o.id), 0)::int as supplied
      from owed_items o join script_lines l on l.id = o.script_line_id join scripts s on s.id = l.script_id
      join patients p on p.id = s.patient_id join items i on i.id = l.item_id left join stock_levels sl on sl.item_id = i.id
     where o.cancelled_at is null ${opts.patientId ? tx`and s.patient_id = ${opts.patientId}` : tx``}
     order by o.created_at`
  return rows
    .map((o) => ({
      id: o.id, scriptId: o.script_id, scriptNo: o.script_no, patientId: o.patient_id, patientName: patientName(o as any), phone: o.phone,
      itemId: o.item_id, stockCode: o.stock_code, description: o.description, onHandUnits: o.on_hand,
      owedUnits: o.qty_units, suppliedUnits: o.supplied, leftUnits: o.qty_units - o.supplied, since: o.created_at,
    }))
    .filter((o) => o.leftUnits > 0)
}

/** Hand over some or all of an owed item. Returns the supply id (for its label). */
export async function supplyOwed(tx: Tx, owedId: string, units: number, opts: { allowNegative?: boolean } = {}, userId?: string): Promise<string> {
  const [o] = await tx`
    select o.*, l.item_id, l.unit_cost, l.item_total, l.qty_units as line_qty, s.script_no, s.status,
           coalesce((select sum(os.qty_units) from owed_supplies os where os.owed_item_id = o.id), 0)::int as supplied
      from owed_items o join script_lines l on l.id = o.script_line_id join scripts s on s.id = l.script_id
     where o.id = ${owedId} for update of o`
  if (!o) throw new DomainError('unknown owed item', 'not_found', 404)
  if (o.cancelled_at) throw new DomainError('this owed item was cancelled')
  if (o.status !== 'dispensed') throw new DomainError('the script is not dispensed')
  const left = o.qty_units - o.supplied
  if (!Number.isInteger(units) || units <= 0 || units > left) throw new DomainError(`give between 1 and ${left} units`)
  const [sup] = await tx`
    insert into owed_supplies (tenant_id, owed_item_id, qty_units, supplied_by) values (${await tenantId(tx)}, ${owedId}, ${units}, ${userId ?? null})
    returning id`
  await postMovements(tx, [{
    itemId: o.item_id, kind: 'dispense', qtyUnits: -units, unitCost: numOrNull(o.unit_cost), unitRetail: num(o.item_total) / o.line_qty,
    refType: 'owed_supply', refId: sup.id, note: `owed on script ${o.script_no}`,
  }], { userId, allowNegative: opts.allowNegative })
  await audit(tx, userId, 'supply_owed', 'script', o.script_line_id, { units, scriptNo: o.script_no })
  return sup.id as string
}

export async function cancelOwed(tx: Tx, owedId: string, reason: string, userId?: string) {
  if (!reason.trim()) throw new DomainError('say why the owed item is cancelled')
  const [o] = await tx`update owed_items set cancelled_at = now(), cancelled_by = ${userId ?? null}, cancel_reason = ${reason.trim()}
                        where id = ${owedId} and cancelled_at is null returning id`
  if (!o) throw new DomainError('unknown or already cancelled owed item', 'not_found', 404)
  await audit(tx, userId, 'cancel_owed', 'owed_item', owedId, { reason: reason.trim() })
}

// ---------------------------------------------------------------- labels

export interface Label {
  patientName: string
  description: string
  qtyUnits: number
  directions: string
  date: Date
  scriptNo: number | null
  doctorName: string | null
  dispenser: string | null
  note: string | null        // "repeat 1 of 2", "owed", ...
}

/** Labels for a dispensed script (one per line handed over), or for one later supply of an owed item. */
export async function labelsFor(tx: Tx, opts: { scriptId?: string; supplyId?: string }, userInitials?: string): Promise<Label[]> {
  if (opts.supplyId) {
    const [r] = await tx`
      select os.qty_units, os.supplied_at, u.name as by_name, l.directions, i.description, s.script_no, s.patient_id,
             d.title, d.initials, d.surname as doc_surname
        from owed_supplies os join owed_items o on o.id = os.owed_item_id join script_lines l on l.id = o.script_line_id
        join scripts s on s.id = l.script_id join items i on i.id = l.item_id left join users u on u.id = os.supplied_by
        left join doctors d on d.id = s.doctor_id
       where os.id = ${opts.supplyId}`
    if (!r) throw new DomainError('unknown supply', 'not_found', 404)
    const p = (await getPatient(tx, r.patient_id))!
    return [{
      patientName: p.name, description: r.description, qtyUnits: r.qty_units, directions: r.directions, date: r.supplied_at,
      scriptNo: r.script_no, doctorName: r.doc_surname ? doctorName({ title: r.title, initials: r.initials, surname: r.doc_surname }) : null,
      dispenser: initials(r.by_name) ?? userInitials ?? null, note: 'Balance of owed item',
    }]
  }
  const s = await getScript(tx, opts.scriptId!)
  if (!s) throw new DomainError('unknown script', 'not_found', 404)
  const lines = s.lines.filter((l) => l.supplyUnits > 0)
  return lines.map((l) => ({
    patientName: s.patient.name, description: l.description, qtyUnits: l.supplyUnits, directions: l.directions,
    date: s.dispensedAt ?? new Date(), scriptNo: s.scriptNo, doctorName: s.doctorName,
    dispenser: initials(s.dispensedBy) ?? userInitials ?? null,
    note: s.repeatNo ? `Repeat ${s.repeatNo}` : l.repeats ? `${l.repeats} repeat${l.repeats > 1 ? 's' : ''}` : null,
  }))
}

export function initials(name: string | null | undefined): string | null {
  if (!name) return null
  return name.split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).join('')
}

// ---------------------------------------------------------------- script book and register

export async function scriptBook(tx: Tx, range: { start: Date; end: Date }) {
  const rows = await tx`
    select s.id, s.script_no, s.status, s.dispensed_at, s.rx_date::text as rx, s.total, s.claim_total, s.patient_total, s.repeat_of,
           p.title, p.first_names, p.surname, p.id_no, d.title as doc_title, d.initials as doc_initials, d.surname as doc_surname,
           ma.name as aid_name, s.member_no, u.name as dispensed_by,
           (select string_agg(i.description || ' x' || l.qty_units, '; ' order by l.line_no) from script_lines l join items i on i.id = l.item_id
             where l.script_id = s.id) as items,
           coalesce((select sum(x.total) from sales x where x.script_id = s.id), 0) as paid
      from scripts s join patients p on p.id = s.patient_id left join doctors d on d.id = s.doctor_id
      left join medical_aids ma on ma.id = s.medical_aid_id left join users u on u.id = s.dispensed_by
     where s.status <> 'draft' and s.dispensed_at >= ${range.start} and s.dispensed_at < ${range.end}
     order by s.script_no`
  return rows.map((r) => ({
    id: r.id as string, scriptNo: r.script_no as number, status: r.status as string, dispensedAt: r.dispensed_at as Date, rxDate: r.rx as string,
    repeat: !!r.repeat_of, patientName: patientName(r as any), idNo: r.id_no as string | null,
    doctorName: r.doc_surname ? doctorName({ title: r.doc_title, initials: r.doc_initials, surname: r.doc_surname }) : null,
    medicalAid: r.aid_name as string | null, memberNo: r.member_no as string | null, dispensedBy: r.dispensed_by as string | null,
    items: r.items as string, total: num(r.total), claimTotal: num(r.claim_total), patientTotal: num(r.patient_total), paid: num(r.paid),
  }))
}

export interface RegisterEntry {
  at: Date
  kind: string
  inUnits: number
  outUnits: number
  balance: number
  what: string
  patient: string | null
  patientIdNo: string | null
  patientAddress: string | null
  doctor: string | null
  scriptNo: number | null
  by: string | null
}

/**
 * The register of scheduled medicines: for each item in a registered schedule, every movement
 * in the range with its running balance. It is read straight from the stock ledger, so it always
 * agrees with stock on hand.
 */
export async function register(tx: Tx, range: { start: Date; end: Date }, opts: { itemId?: string } = {}) {
  const settings = await getSettings(tx)
  if (!settings.registerSchedules.length && !opts.itemId) return { schedules: [], items: [] }
  const items = await tx`
    select i.id, i.stock_code, i.description, i.pack_size, i.schedule from items i
     where ${opts.itemId ? tx`i.id = ${opts.itemId}` : tx`i.schedule = any(${settings.registerSchedules}::smallint[])`}
       and exists (select 1 from stock_movements m where m.item_id = i.id and m.occurred_at < ${range.end})
     order by i.description`
  const out = []
  for (const it of items) {
    const rows = await tx`
      with m as (
        select m.*, sum(m.qty_units) over (order by m.occurred_at, m.recorded_at, m.id) as balance
          from stock_movements m where m.item_id = ${it.id} and m.occurred_at < ${range.end}
      )
      select m.id, m.kind, m.qty_units, m.balance, m.occurred_at, m.reason_code, m.note, m.ref_type, u.name as by_name,
             coalesce(s1.script_no, s2.script_no) as script_no,
             coalesce(p1.title, p2.title) as p_title, coalesce(p1.first_names, p2.first_names) as p_first, coalesce(p1.surname, p2.surname) as p_surname,
             coalesce(p1.id_no, p2.id_no) as p_id_no, coalesce(p1.address, p2.address) as p_address,
             coalesce(d1.title, d2.title) as d_title, coalesce(d1.initials, d2.initials) as d_initials, coalesce(d1.surname, d2.surname) as d_surname,
             coalesce(d1.practice_no, d2.practice_no) as d_practice,
             sup.name as supplier, inv.invoice_no, sa.sale_no, r.label as reason
        from m left join users u on u.id = m.user_id
        left join scripts s1 on m.ref_type = 'script' and s1.id = m.ref_id
        left join patients p1 on p1.id = s1.patient_id left join doctors d1 on d1.id = s1.doctor_id
        left join owed_supplies os on m.ref_type = 'owed_supply' and os.id = m.ref_id
        left join owed_items oi on oi.id = os.owed_item_id left join script_lines sl on sl.id = oi.script_line_id
        left join scripts s2 on s2.id = sl.script_id left join patients p2 on p2.id = s2.patient_id left join doctors d2 on d2.id = s2.doctor_id
        left join supplier_invoices inv on m.ref_type = 'supplier_invoice' and inv.id = m.ref_id left join suppliers sup on sup.id = inv.supplier_id
        left join sales sa on m.ref_type = 'sale' and sa.id = m.ref_id
        left join adjustment_reasons r on r.code = m.reason_code
       order by m.occurred_at, m.recorded_at, m.id`
    const before = rows.filter((r) => r.occurred_at < range.start)
    const opening = before.length ? Number(before[before.length - 1].balance) : 0
    const entries: RegisterEntry[] = rows.filter((r) => r.occurred_at >= range.start).map((r) => {
      const isScript = r.script_no !== null
      const what = isScript
        ? (r.qty_units > 0 ? `Script ${r.script_no} reversed` : r.ref_type === 'owed_supply' ? `Owed on script ${r.script_no}` : `Script ${r.script_no}`)
        : r.kind === 'receipt' ? `Received from ${r.supplier ?? 'supplier'}${r.invoice_no ? `, invoice ${r.invoice_no}` : ''}`
        : r.kind === 'sale' ? `Sold at the till${r.sale_no ? `, sale ${r.sale_no}` : ''}`
        : r.kind === 'sale_return' ? `Refund at the till${r.sale_no ? `, sale ${r.sale_no}` : ''}`
        : r.kind === 'adjustment' ? `Adjustment: ${r.reason ?? r.reason_code ?? ''}${r.note ? ` (${r.note})` : ''}`
        : r.kind === 'stocktake' ? 'Stock take' : r.kind === 'opening' ? 'Opening stock' : r.kind.replace('_', ' ')
      return {
        at: r.occurred_at, kind: r.kind, inUnits: r.qty_units > 0 ? r.qty_units : 0, outUnits: r.qty_units < 0 ? -r.qty_units : 0,
        balance: Number(r.balance), what,
        patient: isScript ? patientName({ title: r.p_title, first_names: r.p_first, surname: r.p_surname }) : null,
        patientIdNo: isScript ? r.p_id_no : null, patientAddress: isScript ? r.p_address : null,
        doctor: isScript && r.d_surname ? `${doctorName({ title: r.d_title, initials: r.d_initials, surname: r.d_surname })}${r.d_practice ? ` (${r.d_practice})` : ''}` : null,
        scriptNo: r.script_no, by: r.by_name,
      }
    })
    if (!entries.length && opening === 0) continue
    const closing = entries.length ? entries[entries.length - 1].balance : opening
    out.push({ itemId: it.id as string, stockCode: it.stock_code as string, description: it.description as string, packSize: it.pack_size as number,
      schedule: it.schedule as number | null, opening, closing, entries })
  }
  return { schedules: settings.registerSchedules, items: out }
}

// ---------------------------------------------------------------- the till

/** What a till needs to take payment for a script, found by its number. */
export async function scriptForTill(tx: Tx, scriptNo: number) {
  const [row] = await tx`select id from scripts where script_no = ${scriptNo}`
  if (!row) return null
  const s = (await getScript(tx, row.id))!
  return {
    id: s.id, scriptNo: s.scriptNo, status: s.status, patientName: s.patient.name, accountId: s.patient.accountId,
    medicalAid: s.medicalAidName, memberNo: s.memberNo ? `${s.memberNo}${s.dependantCode ? '/' + s.dependantCode : ''}` : null,
    total: s.total, claimTotal: s.claimTotal, patientTotal: s.patientTotal, paid: s.paid,
    lines: s.lines.map((l) => ({ scriptLineId: l.id, itemId: l.itemId, stockCode: l.stockCode, description: l.description, packSize: l.packSize,
      qtyUnits: l.qtyUnits, lineTotal: l.lineTotal, vat: l.vat })),
  }
}

// ---------------------------------------------------------------- lists

/** A patient's scripts, newest first, with what was on them. */
export async function patientScripts(tx: Tx, patientId: string) {
  const rows = await tx`
    select s.id, s.script_no, s.status, s.rx_date::text as rx, s.dispensed_at, s.created_at, s.total, s.repeat_of,
           d.title, d.initials, d.surname,
           (select string_agg(i.description || ' x' || l.qty_units, '; ' order by l.line_no) from script_lines l join items i on i.id = l.item_id
             where l.script_id = s.id) as items,
           (select coalesce(sum(greatest(l.repeats - (select count(*) from script_lines rl join scripts rs on rs.id = rl.script_id
                                                      where rl.repeat_of_line = l.id and rs.status = 'dispensed'), 0)), 0)
              from script_lines l where l.script_id = s.id)::int as repeats_left
      from scripts s left join doctors d on d.id = s.doctor_id
     where s.patient_id = ${patientId}
     order by coalesce(s.dispensed_at, s.created_at) desc limit 200`
  return rows.map((r) => ({
    id: r.id as string, scriptNo: r.script_no as number | null, status: r.status as string, rxDate: r.rx as string,
    at: (r.dispensed_at ?? r.created_at) as Date, total: num(r.total), repeat: !!r.repeat_of,
    doctorName: r.surname ? doctorName({ title: r.title, initials: r.initials, surname: r.surname }) : null,
    items: (r.items as string | null) ?? '', repeatsLeft: r.repeat_of || r.status !== 'dispensed' ? 0 : (r.repeats_left as number),
  }))
}

/** Scripts captured but not dispensed yet ("unfinished"), oldest first. */
export async function draftScripts(tx: Tx) {
  const rows = await tx`
    select s.id, s.created_at, s.repeat_of, p.title, p.first_names, p.surname, u.name as by_name,
           (select count(*) from script_lines l where l.script_id = s.id)::int as lines
      from scripts s join patients p on p.id = s.patient_id left join users u on u.id = s.created_by
     where s.status = 'draft' order by s.created_at`
  return rows.map((r) => ({ id: r.id as string, createdAt: r.created_at as Date, repeat: !!r.repeat_of, patientName: patientName(r as any),
    by: r.by_name as string | null, lines: r.lines as number }))
}

export async function scriptIdByNo(tx: Tx, scriptNo: number): Promise<string | null> {
  if (!Number.isInteger(scriptNo)) return null
  const [s] = await tx`select id from scripts where script_no = ${scriptNo}`
  return s ? (s.id as string) : null
}
