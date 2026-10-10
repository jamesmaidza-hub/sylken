import type { Tx } from '../db/index.js'
import { DomainError } from './errors.js'
import { audit } from './items.js'

/**
 * Patients, doctors and medical aids for dispensing. A patient is either a main member (or a
 * private patient) or a dependant under a main member; the medical aid and member number live
 * on the main member, so a change there reaches every dependant.
 */

const clean = (s: string | null | undefined) => (s ?? '').trim() || null

export async function tenantId(tx: Tx): Promise<string> {
  const [t] = await tx`select current_setting('app.tenant_id') as id`
  return t.id
}

// ---------------------------------------------------------------- medical aids

export interface MedicalAid { id: string; name: string; code: string | null; message: string | null; active: boolean }

export async function listMedicalAids(tx: Tx, opts: { activeOnly?: boolean } = {}): Promise<MedicalAid[]> {
  const rows = await tx`select * from medical_aids where ${opts.activeOnly ? tx`active` : tx`true`} order by name`
  return rows.map((m) => ({ id: m.id, name: m.name, code: m.code, message: m.message, active: m.active }))
}

export async function saveMedicalAid(tx: Tx, input: { id?: string; name: string; code?: string | null; message?: string | null; active?: boolean }, userId?: string) {
  const name = input.name.trim()
  if (!name) throw new DomainError('a medical aid needs a name')
  if (input.id) {
    await tx`update medical_aids set name = ${name}, code = ${clean(input.code)}, message = ${clean(input.message)}, active = ${input.active ?? true}
              where id = ${input.id}`
    await audit(tx, userId, 'update', 'medical_aid', input.id, { name })
    return input.id
  }
  const [row] = await tx`
    insert into medical_aids (tenant_id, name, code, message) values (current_setting('app.tenant_id')::uuid, ${name}, ${clean(input.code)}, ${clean(input.message)})
    on conflict (tenant_id, name) do nothing returning id`
  if (!row) throw new DomainError(`${name} is already on the list`, 'duplicate', 409)
  await audit(tx, userId, 'create', 'medical_aid', row.id, { name })
  return row.id as string
}

// ---------------------------------------------------------------- doctors

export interface Doctor { id: string; surname: string; initials: string | null; title: string; practiceNo: string | null; phone: string | null; active: boolean; name: string }

export const doctorName = (d: { title?: string | null; initials?: string | null; surname: string }) =>
  [d.title, d.initials, d.surname].filter(Boolean).join(' ')

function toDoctor(d: any): Doctor {
  return { id: d.id, surname: d.surname, initials: d.initials, title: d.title, practiceNo: d.practice_no, phone: d.phone, active: d.active, name: doctorName(d) }
}

export async function listDoctors(tx: Tx, q = '', opts: { activeOnly?: boolean } = {}): Promise<Doctor[]> {
  const term = q.trim().toUpperCase()
  const rows = await tx`
    select * from doctors
     where ${opts.activeOnly ? tx`active` : tx`true`}
       ${term ? tx`and (upper(surname) like ${term + '%'} or practice_no = ${q.trim()})` : tx``}
     order by upper(surname), initials limit 500`
  return rows.map(toDoctor)
}

export async function getDoctor(tx: Tx, id: string): Promise<Doctor | null> {
  const [d] = await tx`select * from doctors where id = ${id}`
  return d ? toDoctor(d) : null
}

export interface DoctorInput { surname: string; initials?: string | null; title?: string | null; practiceNo?: string | null; phone?: string | null; active?: boolean }

export async function saveDoctor(tx: Tx, input: DoctorInput & { id?: string }, userId?: string): Promise<string> {
  const surname = input.surname.trim()
  if (!surname) throw new DomainError('a doctor needs a surname')
  const row = {
    surname, initials: clean(input.initials)?.toUpperCase() ?? null, title: clean(input.title) ?? 'Dr',
    practice_no: clean(input.practiceNo), phone: clean(input.phone), active: input.active ?? true,
  }
  if (row.practice_no) {
    const [dupe] = await tx`select id from doctors where practice_no = ${row.practice_no} and id <> ${input.id ?? '00000000-0000-0000-0000-000000000000'}`
    if (dupe) throw new DomainError(`practice number ${row.practice_no} is already on another doctor`, 'duplicate', 409)
  }
  if (input.id) {
    await tx`update doctors set ${tx(row)} where id = ${input.id}`
    await audit(tx, userId, 'update', 'doctor', input.id, row)
    return input.id
  }
  const [d] = await tx`insert into doctors ${tx({ ...row, tenant_id: await tenantId(tx) })} returning id`
  await audit(tx, userId, 'create', 'doctor', d.id, row)
  return d.id as string
}

// ---------------------------------------------------------------- patients

export interface Patient {
  id: string
  surname: string
  firstNames: string | null
  title: string | null
  name: string                     // "Mrs K Mothibi" style, for lists and labels
  idNo: string | null
  dateOfBirth: string | null       // YYYY-MM-DD
  sex: 'F' | 'M' | 'X' | null
  phone: string | null
  address: string | null
  mainMemberId: string | null
  mainMemberName: string | null
  medicalAidId: string | null      // the main member's, for a dependant
  medicalAidName: string | null
  medicalAidMessage: string | null
  memberNo: string | null
  dependantCode: string | null
  doctorId: string | null
  doctorName: string | null
  accountId: string | null
  accountName: string | null
  notes: string | null
  active: boolean
}

export const patientName = (p: { title?: string | null; firstNames?: string | null; first_names?: string | null; surname: string }) => {
  const first = (p.firstNames ?? p.first_names ?? '').trim()
  return [p.title, first, p.surname].filter(Boolean).join(' ')
}

/** Age in whole years on a date, from YYYY-MM-DD. */
export function ageOn(dob: string | null, on = new Date()): number | null {
  if (!dob) return null
  const [y, m, d] = dob.split('-').map(Number)
  let age = on.getFullYear() - y
  if (on.getMonth() + 1 < m || (on.getMonth() + 1 === m && on.getDate() < d)) age--
  return age
}

const patientSelect = (tx: Tx) => tx`
  select p.*, p.date_of_birth::text as dob,
         mm.surname as mm_surname, mm.first_names as mm_first_names, mm.title as mm_title,
         ma.id as aid_id, ma.name as aid_name, ma.message as aid_message,
         coalesce(mm.member_no, p.member_no) as eff_member_no,
         d.surname as doc_surname, d.initials as doc_initials, d.title as doc_title,
         a.name as account_name
    from patients p
    left join patients mm on mm.id = p.main_member_id
    left join medical_aids ma on ma.id = coalesce(mm.medical_aid_id, p.medical_aid_id)
    left join doctors d on d.id = p.doctor_id
    left join customer_accounts a on a.id = p.account_id`

function toPatient(p: any): Patient {
  return {
    id: p.id, surname: p.surname, firstNames: p.first_names, title: p.title, name: patientName(p),
    idNo: p.id_no, dateOfBirth: p.dob, sex: p.sex, phone: p.phone, address: p.address,
    mainMemberId: p.main_member_id,
    mainMemberName: p.main_member_id ? patientName({ title: p.mm_title, first_names: p.mm_first_names, surname: p.mm_surname }) : null,
    medicalAidId: p.aid_id, medicalAidName: p.aid_name, medicalAidMessage: p.aid_message, memberNo: p.eff_member_no,
    dependantCode: p.dependant_code, doctorId: p.doctor_id,
    doctorName: p.doctor_id ? doctorName({ title: p.doc_title, initials: p.doc_initials, surname: p.doc_surname }) : null,
    accountId: p.account_id, accountName: p.account_name, notes: p.notes, active: p.active,
  }
}

export async function getPatient(tx: Tx, id: string): Promise<Patient | null> {
  const [p] = await tx`${patientSelect(tx)} where p.id = ${id}`
  return p ? toPatient(p) : null
}

/**
 * Find patients by surname (start of it, or "SURNAME FIRST"), ID number, member number or phone.
 * A member number finds the whole family.
 */
/**
 * Lists people family by family: the main member (dependant 00) first, then 01, 02 and so on.
 * Needs the patient as p and their main member as mm.
 */
export const familyOrder = (tx: Tx) => tx`upper(coalesce(mm.surname, p.surname)), upper(coalesce(mm.first_names, p.first_names, '')),
  coalesce(p.main_member_id, p.id), p.main_member_id is not null, p.dependant_code nulls first, upper(coalesce(p.first_names, ''))`

export async function searchPatients(
  tx: Tx, q: string, opts: { limit?: number; includeInactive?: boolean; mainMembersOnly?: boolean } = {},
): Promise<Patient[]> {
  const term = q.trim()
  if (!term) return []
  const upper = term.toUpperCase()
  const [surname, ...rest] = upper.split(/[\s,]+/).filter(Boolean)
  const first = rest.join(' ')
  const active = opts.includeInactive ? tx`true` : tx`p.active`
  const matches = tx`(
         (upper(p.surname) like ${surname + '%'} ${first ? tx`and upper(coalesce(p.first_names, '')) like ${first + '%'}` : tx``})
         or upper(p.id_no) = ${upper}
         or upper(coalesce(mm.member_no, p.member_no)) = ${upper}
         or regexp_replace(coalesce(p.phone, ''), '\\D', '', 'g') = ${term.replace(/\D/g, '') || '-'}
       )`
  // A dependant who matches is shown as their main member, so each family appears once.
  const where = opts.mainMembersOnly
    ? tx`p.id in (select coalesce(p.main_member_id, p.id) from patients p left join patients mm on mm.id = p.main_member_id where ${active} and ${matches})`
    : tx`${active} and ${matches}`
  const rows = await tx`${patientSelect(tx)}
     where ${where}
     order by ${familyOrder(tx)}
     limit ${opts.limit ?? 50}`
  return rows.map(toPatient)
}

export async function familyOf(tx: Tx, patient: Patient): Promise<Patient[]> {
  const mainId = patient.mainMemberId ?? patient.id
  const rows = await tx`${patientSelect(tx)} where (p.id = ${mainId} or p.main_member_id = ${mainId}) order by ${familyOrder(tx)}`
  return rows.map(toPatient)
}

export interface PatientInput {
  surname: string
  firstNames?: string | null
  title?: string | null
  idNo?: string | null
  dateOfBirth?: string | null
  sex?: string | null
  phone?: string | null
  address?: string | null
  mainMemberId?: string | null
  medicalAidId?: string | null
  memberNo?: string | null
  dependantCode?: string | null
  doctorId?: string | null
  accountId?: string | null
  notes?: string | null
  active?: boolean
}

async function shapePatient(tx: Tx, input: PatientInput, id?: string) {
  const surname = input.surname.trim().toUpperCase()
  if (!surname) throw new DomainError('a patient needs a surname')
  const dob = clean(input.dateOfBirth)
  if (dob) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob))) throw new DomainError('date of birth must be a date')
    if (dob > new Date().toISOString().slice(0, 10)) throw new DomainError('date of birth is in the future')
  }
  const sex = clean(input.sex)?.toUpperCase() ?? null
  if (sex && !['F', 'M', 'X'].includes(sex)) throw new DomainError('sex must be F, M or X')
  const mainMemberId = clean(input.mainMemberId)
  let medicalAidId = clean(input.medicalAidId)
  let memberNo = clean(input.memberNo)?.toUpperCase() ?? null
  let dependantCode = clean(input.dependantCode)
  if (mainMemberId) {
    if (mainMemberId === id) throw new DomainError('a patient cannot be their own main member')
    const [mm] = await tx`select id, main_member_id from patients where id = ${mainMemberId}`
    if (!mm) throw new DomainError('main member not found', 'not_found', 404)
    if (mm.main_member_id) throw new DomainError('a dependant must sit under the main member, not under another dependant')
    if (id) {
      const [deps] = await tx`select count(*)::int as n from patients where main_member_id = ${id}`
      if (deps.n) throw new DomainError('this patient has dependants of their own, so cannot become a dependant')
    }
    medicalAidId = null
    memberNo = null
    if (!dependantCode) {
      const [n] = await tx`select count(*)::int as n from patients where main_member_id = ${mainMemberId} and id <> ${id ?? '00000000-0000-0000-0000-000000000000'}`
      dependantCode = String(n.n + 1).padStart(2, '0')
    }
  } else if (medicalAidId) {
    const [ma] = await tx`select id from medical_aids where id = ${medicalAidId}`
    if (!ma) throw new DomainError('unknown medical aid', 'not_found', 404)
    if (!memberNo) throw new DomainError('a medical aid member needs a member number')
    dependantCode = dependantCode ?? '00'
  } else if (!memberNo) {
    dependantCode = null
  }
  // A private account keeps its account number (from Compharm) in member_no, so search by number finds the family.
  if (dependantCode) {
    if (!/^\d{1,2}$/.test(dependantCode)) throw new DomainError('the dependant code is a number: 00 for the main member, 01 for the first dependant')
    dependantCode = dependantCode.padStart(2, '0')
  }
  if (input.doctorId) {
    const [d] = await tx`select id from doctors where id = ${input.doctorId}`
    if (!d) throw new DomainError('unknown doctor', 'not_found', 404)
  }
  if (input.accountId) {
    const [a] = await tx`select id from customer_accounts where id = ${input.accountId}`
    if (!a) throw new DomainError('unknown customer account', 'not_found', 404)
  }
  return {
    surname, first_names: clean(input.firstNames)?.toUpperCase() ?? null, title: clean(input.title),
    id_no: clean(input.idNo)?.toUpperCase() ?? null, date_of_birth: dob, sex, phone: clean(input.phone), address: clean(input.address),
    main_member_id: mainMemberId, medical_aid_id: medicalAidId, member_no: memberNo, dependant_code: dependantCode,
    doctor_id: clean(input.doctorId), account_id: clean(input.accountId), notes: clean(input.notes), active: input.active ?? true,
  }
}

export async function createPatient(tx: Tx, input: PatientInput, userId?: string): Promise<string> {
  const row = await shapePatient(tx, input)
  if (row.member_no && !row.main_member_id) {
    const [dupe] = await tx`select id from patients where member_no = ${row.member_no} and medical_aid_id = ${row.medical_aid_id} and main_member_id is null`
    if (dupe) throw new DomainError(`member number ${row.member_no} already belongs to a main member; add this patient as their dependant`, 'duplicate', 409)
  }
  const [p] = await tx`insert into patients ${tx({ ...row, tenant_id: await tenantId(tx) })} returning id`
  await audit(tx, userId, 'create', 'patient', p.id, { surname: row.surname })
  return p.id as string
}

export async function updatePatient(tx: Tx, id: string, input: PatientInput, userId?: string) {
  const [old] = await tx`select id from patients where id = ${id}`
  if (!old) throw new DomainError('unknown patient', 'not_found', 404)
  const row = await shapePatient(tx, input, id)
  await tx`update patients set ${tx(row)}, updated_at = now() where id = ${id}`
  await audit(tx, userId, 'update', 'patient', id, row)
}

// ---------------------------------------------------------------- allergies and alerts

export interface PatientFlag { id: string; kind: 'allergy' | 'alert'; text: string; detail: string | null; createdAt: Date; createdBy: string | null }

export async function patientFlags(tx: Tx, patientId: string): Promise<PatientFlag[]> {
  const rows = await tx`
    select f.*, u.name as created_by_name from patient_flags f left join users u on u.id = f.created_by
     where f.patient_id = ${patientId} and f.removed_at is null order by f.kind, f.created_at`
  return rows.map((f) => ({ id: f.id, kind: f.kind, text: f.text, detail: f.detail, createdAt: f.created_at, createdBy: f.created_by_name }))
}

export async function addFlag(tx: Tx, patientId: string, input: { kind: 'allergy' | 'alert'; text: string; detail?: string | null }, userId?: string) {
  const text = input.text.trim()
  if (!text) throw new DomainError(input.kind === 'allergy' ? 'say what the patient is allergic to' : 'an alert needs some text')
  if (!['allergy', 'alert'].includes(input.kind)) throw new DomainError('unknown kind of flag')
  const [p] = await tx`select id from patients where id = ${patientId}`
  if (!p) throw new DomainError('unknown patient', 'not_found', 404)
  await tx`
    insert into patient_flags (tenant_id, patient_id, kind, text, detail, created_by)
    values (current_setting('app.tenant_id')::uuid, ${patientId}, ${input.kind}, ${input.kind === 'allergy' ? text.toUpperCase() : text}, ${clean(input.detail)}, ${userId ?? null})`
  await audit(tx, userId, 'add_' + input.kind, 'patient', patientId, { text })
}

export async function removeFlag(tx: Tx, flagId: string, userId?: string) {
  const [f] = await tx`update patient_flags set removed_at = now(), removed_by = ${userId ?? null} where id = ${flagId} and removed_at is null returning patient_id, kind, text`
  if (!f) throw new DomainError('already removed', 'not_found', 404)
  await audit(tx, userId, 'remove_' + f.kind, 'patient', f.patient_id, { text: f.text })
  return f.patient_id as string
}

/**
 * Words of an allergy that appear in an item's description. sylken has no ingredient data,
 * so this only catches allergies written the way the item is named (e.g. "AMOXICILLIN"); the
 * pharmacist still confirms every patient with allergies by hand.
 */
export function allergyHits(allergies: string[], description: string): string[] {
  const desc = description.toUpperCase()
  const hits: string[] = []
  for (const a of allergies) {
    const words = a.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 4)
    if (words.some((w) => desc.includes(w))) hits.push(a)
  }
  return hits
}

// ---------------------------------------------------------------- directions

export const defaultDirections: [string, string][] = [
  ['1T1D', 'Take ONE tablet ONCE a day'],
  ['1T2D', 'Take ONE tablet TWICE a day'],
  ['1T3D', 'Take ONE tablet THREE times a day'],
  ['1T4D', 'Take ONE tablet FOUR times a day'],
  ['2T3D', 'Take TWO tablets THREE times a day'],
  ['1TN', 'Take ONE tablet at NIGHT'],
  ['1TM', 'Take ONE tablet in the MORNING'],
  ['1C2D', 'Take ONE capsule TWICE a day'],
  ['1C3D', 'Take ONE capsule THREE times a day'],
  ['5ML3D', 'Take 5 ml THREE times a day'],
  ['10ML3D', 'Take 10 ml THREE times a day'],
  ['PRN', 'Use when needed, as directed'],
  ['APPLY2D', 'Apply thinly TWICE a day'],
  ['AD', 'Use as directed'],
]

export async function listDirections(tx: Tx) {
  const rows = await tx`select code, text from directions order by code`
  return rows.map((d) => ({ code: d.code as string, text: d.text as string }))
}

export async function saveDirection(tx: Tx, code: string, text: string, userId?: string) {
  const c = code.trim().toUpperCase()
  if (!/^[A-Z0-9.]{1,12}$/.test(c)) throw new DomainError('a direction code is up to 12 letters or digits')
  if (!text.trim()) {
    await tx`delete from directions where code = ${c}`
    await audit(tx, userId, 'delete', 'direction', c)
    return
  }
  await tx`
    insert into directions (tenant_id, code, text) values (current_setting('app.tenant_id')::uuid, ${c}, ${text.trim()})
    on conflict (tenant_id, code) do update set text = excluded.text`
  await audit(tx, userId, 'save', 'direction', c, { text: text.trim() })
}

/** A typed direction that is exactly a code becomes its text; anything else is kept as typed. */
export async function expandDirections(tx: Tx, typed: string): Promise<string> {
  const t = typed.trim()
  if (!t) return ''
  const [d] = await tx`select text from directions where code = ${t.toUpperCase()}`
  return d ? (d.text as string) : t
}
