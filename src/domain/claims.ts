import type { Tx } from '../db/index.js'
import { num } from '../db/index.js'
import { DomainError } from './errors.js'
import { audit } from './items.js'
import { tenantId } from './patients.js'
import { round2 } from './pricing.js'
import { bounds, type DayRange } from './sales.js'
import { getSettings, getShop } from './settings.js'
import { nextNumber } from './till.js'

/**
 * Medical aid claims as Allegra Connect XML batch files, the format AFA asks for on behalf of
 * Pula Medical Aid Fund ("Allegra Connect XML for Batch/Real-Time Claim Submissions", v1.09).
 *
 * One batch is one medical aid and a range of dispensing days. Each dispensed script billed to
 * that aid becomes a <Claim> with its claimable lines (lines marked "patient pays" stay out).
 * A script that can't be claimed yet (no NAPPI code on a line, no doctor's practice number, no
 * date of birth...) is left out and listed with the reason, so it can be fixed and go in the
 * next batch. Scripts reversed after they were sent go in the next batch as reversals.
 */

/** Who sent the batch, as the format asks: String-10 in the header, String-50 on each claim. */
export const claimSource = { header: 'sylken_0.1', claim: 'sylken 0.1' }

/** Allegra's provider type for Botswana providers. */
const providerType = 'BP'

export interface ClaimLine {
  lineNo: number
  nappiCode: string
  description: string
  treatmentDate: string            // YYYY-MM-DD
  qtyUnits: number
  daysSupplied: number
  gross: number                    // incl VAT, dispensing fee included
  fee: number
  vat: number
  icd10: string[]
  originalScriptNo: number | null  // on a repeat
  repeatNo: number | null
  repeatsAuthorised: number | null
}

export interface Claim {
  kind: 'Request' | 'Reversal'
  scriptId: string
  scriptNo: number
  dispensedAt: Date
  prescriberPracticeNo: string
  prescriberName: string | null
  member: { memberNo: string; firstName: string; surname: string; title: string | null }
  patient: { firstName: string; surname: string; dateOfBirth: string; sex: 'M' | 'F' | 'U'; idNo: string | null; dependantNo: string }
  lines: ClaimLine[]
}

export interface ClaimFile {
  batchNo: number
  batchDate: string                // YYYY-MM-DD
  schemeCode: string
  planCode: string
  practiceNo: string
  practiceName: string
  test: boolean
  timezone: string
  claims: Claim[]
}

// ---------------------------------------------------------------- the XML

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const cut = (s: string, n: number) => s.trim().slice(0, n)
const amt = (n: number) => round2(n).toFixed(2)
const initials = (names: string) => names.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 5)

/** CCYY-MM-DD-HH-mm-SS in the shop's time zone. */
export function claimDateTime(at: Date, timezone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}-${p.hour}-${p.minute}-${p.second}`
}

/** A NAPPI code as typed ("708564-001") split into the code and its extended code. */
export function splitNappi(code: string) {
  const [base, ext] = code.split('-')
  return { code: base, extended: ext ?? null }
}

const lineGross = (c: Claim) => round2(c.lines.reduce((a, l) => a + l.gross, 0))

/**
 * The batch file. Optional elements with nothing in them are left out, as the format asks.
 * Amounts are in Pula with two decimals; quantities carry two implied decimals (1 unit = 100).
 */
export function claimXml(f: ClaimFile): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<ClaimBatch>']
  let depth = 1
  const el = (name: string, value: string | number | null | undefined) => {
    if (value === null || value === undefined || value === '') return
    out.push(`${'  '.repeat(depth)}<${name}>${esc(String(value))}</${name}>`)
  }
  const open = (name: string) => { out.push(`${'  '.repeat(depth)}<${name}>`); depth++ }
  const close = (name: string) => { depth--; out.push(`${'  '.repeat(depth)}</${name}>`) }
  const diagnoses = (pairs: { lineNo: number; code: string; qualifier: string }[]) => {
    if (!pairs.length) return
    open('Diagnoses')
    for (const d of pairs) {
      open('Diagnosis'); el('lineNo', d.lineNo); el('code', d.code); el('type', 'ICD-10'); el('qualifier', d.qualifier); close('Diagnosis')
    }
    close('Diagnoses')
  }
  const lineDiagnoses = (l: ClaimLine) => l.icd10.map((code, i) => ({ lineNo: l.lineNo, code, qualifier: i === 0 ? 'P' : 'S' }))

  open('BatchHeader')
  el('batchDate', f.batchDate)
  el('batchNo', f.batchNo)
  el('schemeName', cut(f.schemeCode, 10))
  el('source', claimSource.header)
  close('BatchHeader')

  for (const c of f.claims) {
    const gross = lineGross(c)
    const fees = round2(c.lines.reduce((a, l) => a + l.fee, 0))
    const vat = round2(c.lines.reduce((a, l) => a + l.vat, 0))
    open('Claim')
    el('transactionType', c.kind)
    el('testClaim', f.test ? 'true' : 'false')
    el('planCode', cut(f.planCode, 10))
    el('providerType', providerType)
    el('providerBHF', cut(f.practiceNo, 13))
    el('providerName', cut(f.practiceName, 30))
    el('prescribingProviderBHF', cut(c.prescriberPracticeNo, 13))
    el('prescribingProviderName', c.prescriberName && cut(c.prescriberName, 30))
    el('transactionNo', c.scriptNo)
    el('inHospitalClaim', 'N')
    el('providerSubmittedInd', 'Y')
    el('source', claimSource.claim)
    el('transactionDate', claimDateTime(c.dispensedAt, f.timezone))
    el('numLines', c.lines.length)
    el('itemCount', new Set(c.lines.map((l) => l.nappiCode)).size)
    diagnoses(c.lines.flatMap(lineDiagnoses))
    open('ClaimTotals')
    el('claimGross', amt(gross))
    el('claimNett', amt(gross))
    el('claimDispensingFee', amt(fees))
    el('claimVATAmount', amt(vat))
    el('claimPatientPayAmount', amt(0))
    el('payInstruction', 'P')
    close('ClaimTotals')
    open('Membership')
    el('membershipNo', cut(c.member.memberNo, 20))
    el('memberInitials', initials(c.member.firstName))
    el('memberFirstName', cut(c.member.firstName.split(/\s+/)[0], 20))
    el('memberSurname', cut(c.member.surname, 30))
    el('memberTitle', c.member.title && cut(c.member.title, 5))
    el('beneficiaryInitials', initials(c.patient.firstName))
    el('beneficiaryFirstName', cut(c.patient.firstName.split(/\s+/)[0], 30))
    el('beneficiarySurname', cut(c.patient.surname, 30))
    el('beneficiaryDOB', c.patient.dateOfBirth)
    el('beneficiaryGender', c.patient.sex)
    el('beneficiaryId', c.patient.idNo && cut(c.patient.idNo, 13))
    el('dependantNo', c.patient.dependantNo)
    close('Membership')
    open('Lines')
    for (const l of c.lines) {
      const n = splitNappi(l.nappiCode)
      open('Line')
      el('lineNo', l.lineNo)
      el('lineType', 'L')
      el('itemCodeType', 'Nappi')
      el('chargeableCode', n.code)
      el('extendedCode', n.extended)
      el('chargeableDescription', cut(l.description, 40))
      el('chargeableTreatmentDate', l.treatmentDate)
      el('chargeableQuantity', l.qtyUnits * 100)
      el('inHospitalInd', 'N')
      el('benefitCode', '0')
      el('dispensingLocation', 'P')
      el('daysSupplied', l.daysSupplied)
      el('originalScriptNo', l.originalScriptNo)
      el('repeatNo', l.repeatNo)
      if (l.repeatNo) el('repeatAuthoriser', 'D')
      el('repeatAuthorised', l.repeatsAuthorised)
      open('LineTotals')
      el('grossAmount', amt(l.gross))
      el('nettAmount', amt(l.gross))
      el('dispensingFee', amt(l.fee))
      el('vatAmount', amt(l.vat))
      el('patientPaidAmount', amt(0))
      el('payInstruction', 'P')
      close('LineTotals')
      diagnoses(lineDiagnoses(l))
      close('Line')
    }
    close('Lines')
    close('Claim')
  }

  open('BatchTrailer')
  el('numClaims', f.claims.length)
  el('batchTotal', amt(f.claims.reduce((a, c) => a + lineGross(c), 0)))
  close('BatchTrailer')
  out.push('</ClaimBatch>')
  return out.join('\n') + '\n'
}

/** ClaimsFileDDMMYYYY_NNN.xml, as in the format's file naming example. */
export function claimFileName(batchDate: string, batchNo: number) {
  const [y, m, d] = batchDate.split('-')
  return `ClaimsFile${d}${m}${y}_${String(batchNo).padStart(3, '0')}.xml`
}

// ---------------------------------------------------------------- what can be claimed

export interface ClaimCandidate {
  scriptId: string
  scriptNo: number
  kind: 'Request' | 'Reversal'
  dispensedAt: Date
  patient: string
  memberNo: string | null
  amount: number
  problems: string[]               // empty when the script can go in a batch
  claim: Claim | null
}

const sexCode = (s: string | null): 'M' | 'F' | 'U' => (s === 'M' || s === 'F' ? s : 'U')

/**
 * Scripts billed to the medical aid and dispensed in the range that are not in a batch yet,
 * plus scripts sent before and reversed since. Each one says what stops it being claimed.
 */
export async function claimCandidates(tx: Tx, medicalAidId: string, range: DayRange, opts: { test?: boolean } = {}): Promise<ClaimCandidate[]> {
  const b = await bounds(tx, range)
  const s = await getSettings(tx)
  // A test batch can be made again from the same scripts; a real one never sends a script twice.
  const sent = (kind: string) => opts.test ? tx`false` : tx`exists (select 1 from claim_batch_scripts cs where cs.script_id = sc.id and cs.kind = ${kind} and not cs.test)`
  const rows = await tx`
    select sc.id, sc.script_no, sc.status, sc.dispensed_at, sc.member_no, sc.dependant_code, sc.claim_total,
           to_char(sc.dispensed_at at time zone ${b.timezone}, 'YYYY-MM-DD') as day,
           p.first_names, p.surname, p.date_of_birth::text as dob, p.sex, p.id_no, p.dependant_code as own_dep, p.main_member_id,
           coalesce(mm.first_names, p.first_names) as m_first, coalesce(mm.surname, p.surname) as m_surname, coalesce(mm.title, p.title) as m_title,
           d.practice_no as doc_practice, d.title as doc_title, d.initials as doc_initials, d.surname as doc_surname,
           orig.script_no as orig_no,
           case when sc.repeat_of is not null then (select count(*) from scripts r where r.repeat_of = sc.repeat_of and r.status <> 'draft'
                                                      and r.dispensed_at <= sc.dispensed_at)::int end as repeat_no,
           case when sc.status = 'reversed' then 'Reversal' else 'Request' end as kind
      from scripts sc join patients p on p.id = sc.patient_id left join patients mm on mm.id = p.main_member_id
      left join doctors d on d.id = sc.doctor_id left join scripts orig on orig.id = sc.repeat_of
     where sc.medical_aid_id = ${medicalAidId} and sc.claim_total > 0
       and ((sc.status = 'dispensed' and sc.dispensed_at >= ${b.start} and sc.dispensed_at < ${b.end} and not ${sent('Request')})
         or (sc.status = 'reversed' and ${opts.test ? tx`false` : tx`exists (select 1 from claim_batch_scripts cs where cs.script_id = sc.id and cs.kind = 'Request' and not cs.test)`}
             and not ${sent('Reversal')}))
     order by sc.dispensed_at, sc.script_no`
  const lines = rows.length ? await tx`
    select l.script_id, l.line_no, l.qty_units, l.supply_days, l.icd10, l.line_total, l.fee, l.line_vat,
           coalesce(l.nappi_code, i.nappi_code) as nappi, i.description, o.repeats as orig_repeats
      from script_lines l join items i on i.id = l.item_id left join script_lines o on o.id = l.repeat_of_line
     where l.script_id in ${tx(rows.map((r) => r.id))} and not l.no_claim
     order by l.script_id, l.line_no` : []

  return rows.map((r) => {
    const own = lines.filter((l) => l.script_id === r.id)
    const problems: string[] = []
    if (!r.member_no) problems.push('no member number')
    if (!r.m_first?.trim()) problems.push("the main member's first name is missing")
    if (!r.first_names?.trim()) problems.push("the patient's first name is missing")
    if (!r.dob) problems.push("the patient's date of birth is missing")
    if (!r.doc_practice) problems.push(r.doc_surname ? `Dr ${r.doc_surname} has no practice number` : 'no prescribing doctor on the script')
    const noNappi = own.filter((l) => !l.nappi).map((l) => l.description)
    if (noNappi.length) problems.push(`no NAPPI code for ${noNappi.join(', ')}`)
    if (!own.length) problems.push('no lines to claim')
    const amount = round2(own.reduce((a, l) => a + num(l.line_total), 0))
    const claim: Claim | null = problems.length ? null : {
      kind: r.kind, scriptId: r.id, scriptNo: r.script_no, dispensedAt: r.dispensed_at,
      prescriberPracticeNo: r.doc_practice,
      prescriberName: [r.doc_title, r.doc_initials, r.doc_surname].filter(Boolean).join(' ') || null,
      member: { memberNo: r.member_no, firstName: r.m_first.trim(), surname: r.m_surname, title: r.m_title },
      patient: {
        firstName: r.first_names.trim(), surname: r.surname, dateOfBirth: r.dob, sex: sexCode(r.sex), idNo: r.id_no,
        dependantNo: r.dependant_code ?? r.own_dep ?? '00',
      },
      lines: own.map((l, i) => ({
        lineNo: i + 1, nappiCode: l.nappi, description: l.description, treatmentDate: r.day, qtyUnits: l.qty_units,
        daysSupplied: l.supply_days ?? s.defaultSupplyDays, gross: num(l.line_total), fee: num(l.fee), vat: num(l.line_vat),
        icd10: l.icd10 ?? [], originalScriptNo: r.orig_no ?? null, repeatNo: r.repeat_no ?? null,
        repeatsAuthorised: r.orig_no ? (l.orig_repeats ?? null) : null,
      })),
    }
    return {
      scriptId: r.id, scriptNo: r.script_no, kind: r.kind, dispensedAt: r.dispensed_at,
      patient: [r.first_names, r.surname].filter(Boolean).join(' '), memberNo: r.member_no, amount, problems, claim,
    }
  })
}

// ---------------------------------------------------------------- batches

export interface ClaimBatch {
  id: string; batchNo: number; medicalAid: string; test: boolean; from: string; to: string
  numClaims: number; total: number; fileName: string; createdAt: Date; createdBy: string | null
}

/**
 * Make the batch file for one medical aid and range, record which scripts went in it, and
 * return it. Scripts with problems are left out; it is refused when nothing can be claimed.
 */
export async function createClaimBatch(tx: Tx, input: { medicalAidId: string; from: string; to: string; test?: boolean }, userId?: string) {
  const s = await getSettings(tx)
  if (!s.practiceNo) throw new DomainError("Set the pharmacy's practice number under Dispensing settings first.")
  const [aid] = await tx`select name, code from medical_aids where id = ${input.medicalAidId}`
  if (!aid) throw new DomainError('unknown medical aid', 'not_found', 404)
  if (!aid.code) throw new DomainError(`Give ${aid.name} its scheme code under Dispensing settings first (the code the medical aid uses for itself).`)
  const test = !!input.test
  const candidates = await claimCandidates(tx, input.medicalAidId, { from: input.from, to: input.to }, { test })
  const claims = candidates.filter((c) => c.claim).map((c) => c.claim!)
  if (!claims.length) throw new DomainError(candidates.length ? 'None of the scripts can be claimed yet: fix the problems listed first.' : 'Nothing to claim in those dates.')

  const shop = await getShop(tx)
  const batchNo = await nextNumber(tx, 'claim_batch')
  const [{ today }] = await tx`select to_char(now() at time zone ${s.timezone}, 'YYYY-MM-DD') as today`
  const file: ClaimFile = {
    batchNo, batchDate: today, schemeCode: aid.code, planCode: aid.code, practiceNo: s.practiceNo, practiceName: shop.name,
    test, timezone: s.timezone, claims,
  }
  const xml = claimXml(file)
  const total = round2(claims.reduce((a, c) => a + lineGross(c), 0))
  const fileName = claimFileName(today, batchNo)
  const tid = await tenantId(tx)
  const [row] = await tx`
    insert into claim_batches (tenant_id, batch_no, medical_aid_id, test, date_from, date_to, num_claims, total, file_name, xml, created_by)
    values (${tid}, ${batchNo}, ${input.medicalAidId}, ${test}, ${input.from}, ${input.to}, ${claims.length}, ${total}, ${fileName}, ${xml}, ${userId ?? null})
    returning id`
  await tx`insert into claim_batch_scripts ${tx(claims.map((c) => ({
    tenant_id: tid, batch_id: row.id, script_id: c.scriptId, kind: c.kind, test, amount: lineGross(c),
  })))}`
  await audit(tx, userId, 'create', 'claim_batch', row.id, { batchNo, test, claims: claims.length, total, left: candidates.length - claims.length })
  return { id: row.id as string, batchNo, fileName, xml, claims: claims.length, total, left: candidates.filter((c) => !c.claim) }
}

export async function listClaimBatches(tx: Tx, limit = 50): Promise<ClaimBatch[]> {
  const rows = await tx`
    select b.id, b.batch_no, b.test, b.date_from::text as f, b.date_to::text as t, b.num_claims, b.total, b.file_name, b.created_at,
           ma.name as aid, u.name as by_name
      from claim_batches b join medical_aids ma on ma.id = b.medical_aid_id left join users u on u.id = b.created_by
     order by b.batch_no desc limit ${limit}`
  return rows.map((r) => ({
    id: r.id, batchNo: r.batch_no, medicalAid: r.aid, test: r.test, from: r.f, to: r.t, numClaims: r.num_claims,
    total: num(r.total), fileName: r.file_name, createdAt: r.created_at, createdBy: r.by_name,
  }))
}

export async function claimBatchFile(tx: Tx, id: string) {
  const [r] = await tx`select file_name, xml from claim_batches where id = ${id}`
  if (!r) throw new DomainError('unknown claim batch', 'not_found', 404)
  return { fileName: r.file_name as string, xml: r.xml as string }
}
