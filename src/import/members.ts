import type { Tx } from '../db/index.js'
import { createPatient, saveMedicalAid } from '../domain/patients.js'
import { readReport } from './sheets.js'

/**
 * Compharm "Members Report" into patients. Rows with the same member number are one family:
 * the first row in the file is the main member (00), the next 01, 02 and so on, in file order.
 * A blank number or "PR" is a private patient with no family. "PRIVATE" is not a medical aid.
 */

export interface MembersReport {
  rows: number
  families: number
  mainMembers: number
  dependants: number
  individuals: number
  medicalAids: number
  issues: { row: number; surname: string; issue: string }[]
}

const s = (v: unknown) => (v == null ? '' : String(v).trim())

function dateOnly(v: unknown): string | null {
  const d = v instanceof Date ? v : v ? new Date(String(v)) : null
  if (!d || Number.isNaN(d.getTime())) return null
  const iso = d.toISOString().slice(0, 10)
  return d.getUTCFullYear() < 1910 || iso > new Date().toISOString().slice(0, 10) ? null : iso
}

export async function importMembers(tx: Tx, file: string): Promise<MembersReport> {
  const [{ n }] = await tx`select count(*)::int as n from patients`
  if (n) throw new Error(`this pharmacy already has ${n} patients; the member import only runs into an empty list`)

  const { rows: keyed } = await readReport(file, ['Mem Aid No'])
  const cols = ['Mem Aid No', 'Member Surname', 'Dependant', 'Title', 'Primary Medical Aid', 'Chronic Medical Aid', 'OTC Medical Aid',
    'Private Medical Aid 1', 'Private Medical Aid 2', 'Private Medical Aid 3', 'ID No', 'Birthday', 'Address 1', 'Address 2',
    'Member Mobile', 'Member Home Nr', 'Member Email']
  const rows = keyed.map((k, i) => Object.assign(cols.map((c) => k[c] ?? null), { __row: i + 1 })).filter((r) => s(r[1]) || s(r[2]))

  const report: MembersReport = { rows: rows.length, families: 0, mainMembers: 0, dependants: 0, individuals: 0, medicalAids: 0, issues: [] }

  const aidNames = new Set<string>()
  for (const r of rows) for (const c of [4, 5, 6]) { const a = s(r[c]).toUpperCase(); if (a && a !== 'PRIVATE') aidNames.add(a) }
  const aidId = new Map<string, string>()
  for (const name of [...aidNames].sort()) aidId.set(name, await saveMedicalAid(tx, { name }))
  report.medicalAids = aidId.size

  const families = new Map<string, any[][]>()
  const order: (string | any[])[] = []
  rows.forEach((r) => {
    const no = s(r[0]).toUpperCase()
    if (!no || no === 'PR') order.push(r)
    else {
      const f = families.get(no)
      if (f) f.push(r)
      else { families.set(no, [r]); order.push(no) }
    }
  })

  const person = (r: any[], extra: Record<string, unknown>) => {
    const email = s(r[16])
    const a1 = s(r[12]).toUpperCase() === 'PR' ? '' : s(r[12])
    return {
      surname: s(r[1]), firstNames: s(r[2]), title: s(r[3]) || null, idNo: s(r[10]) || null, dateOfBirth: dateOnly(r[11]),
      phone: s(r[14]) || s(r[15]) || null, address: [a1, s(r[13])].filter(Boolean).join(', ') || null,
      notes: email ? `Email: ${email}` : null, ...extra,
    }
  }
  const note = (r: any, issue: string) => report.issues.push({ row: r.__row, surname: s(r[1]), issue })

  for (const item of order) {
    if (typeof item !== 'string') {
      try { await createPatient(tx, person(item, {})); report.individuals++ } catch (e) { note(item, (e as Error).message) }
      continue
    }
    const members = families.get(item)!
    const main = members[0]
    const aidName = [4, 5, 6].map((c) => s(main[c]).toUpperCase()).find((a) => a && a !== 'PRIVATE')
    let mainId: string
    try {
      mainId = await createPatient(tx, person(main, { memberNo: item, dependantCode: '00', medicalAidId: aidName ? aidId.get(aidName) : null }))
    } catch (e) { note(main, (e as Error).message); continue }
    report.families++; report.mainMembers++
    for (let i = 1; i < members.length; i++) {
      try {
        await createPatient(tx, person(members[i], { mainMemberId: mainId, dependantCode: String(i).padStart(2, '0') }))
        report.dependants++
      } catch (e) { note(members[i], (e as Error).message) }
    }
  }
  return report
}
