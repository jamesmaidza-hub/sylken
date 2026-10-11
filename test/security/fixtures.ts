import type { Sql } from '../../src/db/index.js'
import { createItem } from '../../src/domain/items.js'
import { addFlag, createPatient, saveDoctor } from '../../src/domain/patients.js'
import { addLine, createDraft } from '../../src/domain/scripts.js'
import { postMovements } from '../../src/domain/stock.js'
import type { Role } from '../../src/security/roles.js'
import { createApp } from '../../src/web/app.js'
import { addUser, newTenant, webLogin } from '../helpers.js'

/**
 * A fake pharmacy with one login per role, each already logged in through the real screens
 * (pharmacists and managers with their authenticator). All names and numbers are made up.
 */
export async function pharmacy(db: Sql) {
  const t = await newTenant(db)
  const app = createApp(db)
  const person = async (roles: Role[], name: string) => {
    const u = await addUser(db, t.id, roles, name)
    const cookie = await webLogin(app, u.email, u.password)
    return client(app, cookie, u)
  }
  const staff = {
    assistant: await person(['assistant'], 'Assistant'),
    dispenser: await person(['dispenser'], 'Dispenser'),
    pharmacist: await person(['pharmacist'], 'Pharmacist'),
    pharmacist2: await person(['pharmacist'], 'Second pharmacist'),
    manager: await person(['manager'], 'Manager'),
  }
  return { t, app, ...staff }
}

export type Client = ReturnType<typeof client>

export function client(app: ReturnType<typeof createApp>, cookie: string, u: { id: string; email: string; password: string }) {
  return {
    ...u, cookie,
    get: (path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { cookie, ...headers } }),
    post: (path: string, body: Record<string, string> = {}) => app.request(path, { method: 'POST', headers: { cookie }, body: new URLSearchParams(body) }),
  }
}

/** A made-up patient with an allergy on record and a draft script for one item in stock. */
export async function draftScript(t: Awaited<ReturnType<typeof newTenant>>, opts: { allergy?: string } = {}) {
  return t.as(async (tx) => {
    const code = `FAKE${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    const item = await createItem(tx, { stockCode: code, description: `FAKEMOXIL ${code} 500MG`, packSize: 10, sellLoose: true, costPerPack: 20 })
    await postMovements(tx, [{ itemId: item.id, kind: 'opening', qtyUnits: 100 }])
    const doctorId = await saveDoctor(tx, { surname: 'Testdoc', initials: 'A', practiceNo: `FAKE-${code}` })
    const patientId = await createPatient(tx, { surname: 'TESTPATIENT', firstNames: 'Fake' })
    if (opts.allergy) await addFlag(tx, patientId, { kind: 'allergy', text: opts.allergy })
    const scriptId = await createDraft(tx, { patientId, doctorId, rxDate: new Date().toISOString().slice(0, 10) })
    await addLine(tx, scriptId, { itemId: item.id, qtyUnits: 10, directions: '1T3D' })
    return { scriptId, patientId, itemId: item.id }
  })
}

export const status = async (tx: { (...a: any[]): any }, scriptId: string) => (await tx`select status from scripts where id = ${scriptId}`)[0].status
