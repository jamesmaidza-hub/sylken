import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../../src/db/index.js'
import { can, roles, rolePermissions } from '../../src/security/roles.js'
import { routePermissions } from '../../src/security/routes.js'
import { createApp } from '../../src/web/app.js'
import { appDb } from '../helpers.js'
import { draftScript, pharmacy } from './fixtures.js'

// Requirements 1.1 to 1.7: docs/security/requirements.md

let db: Sql
let p: Awaited<ReturnType<typeof pharmacy>>
beforeAll(async () => { db = appDb(); p = await pharmacy(db) })
afterAll(async () => { await db.end() })

const fill = (path: string) => path.replace(/:no\b/g, '1').replace(/:[A-Za-z]+/g, randomUUID())

describe('1.3 every route is in the permission table, and nothing else is', () => {
  it('lists each route the app answers exactly once, and only routes that exist', () => {
    const app = createApp(db)
    const served = new Set(app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`))
    const listed = routePermissions.map(([m, path]) => `${m} ${path}`)
    expect(new Set(listed).size, 'a route is listed twice').toBe(listed.length)
    expect([...served].filter((r) => !listed.includes(r)), 'routes with no permission line').toEqual([])
    expect(listed.filter((r) => !served.has(r)), 'permission lines for routes that no longer exist').toEqual([])
  })

  it('refuses a route that was added without a permission line, even for a manager (deny by default)', async () => {
    const app = createApp(db)
    app.get('/not-in-the-table', (c) => c.text('should never be served'))
    const res = await app.request('/not-in-the-table', { headers: { cookie: p.manager.cookie } })
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('should never be served')
  })

  it('needs a login for everything except the login pages and health check (1.1)', async () => {
    const app = createApp(db)
    for (const [method, path, rule] of routePermissions) {
      if (rule === 'public') continue
      const res = await app.request(fill(path), { method })
      if (path.startsWith('/api/')) expect(res.status, `${method} ${path}`).toBe(401)
      else expect(res.headers.get('location'), `${method} ${path}`).toBe('/login')
    }
  })
})

describe('1.3 the server refuses every route a role does not allow', () => {
  for (const role of roles) {
    it(`${role}: every forbidden route answers 403, every allowed screen opens`, async () => {
      const who = { assistant: p.assistant, dispenser: p.dispenser, pharmacist: p.pharmacist, manager: p.manager }[role]
      const wrong: string[] = []
      for (const [method, path, rule] of routePermissions) {
        if (rule === 'public' || rule === 'pending') continue
        const allowed = can([role], rule)
        if (allowed && method === 'POST') continue  // allowed posts would change things; covered by the scenario tests
        const res = method === 'GET' ? await who.get(fill(path)) : await who.post(fill(path))
        if (!allowed && res.status !== 403) wrong.push(`${method} ${path} answered ${res.status}, expected 403`)
        if (allowed && res.status === 403) wrong.push(`${method} ${path} refused, but ${role} has ${rule}`)
      }
      expect(wrong).toEqual([])
    })
  }

  it('gives each role exactly the brief\'s limits', () => {
    expect(can(['assistant'], 'rx.view')).toBe(false)
    expect(can(['assistant'], 'rx.dispense')).toBe(false)
    expect(can(['dispenser'], 'rx.dispense')).toBe(true)
    expect(can(['dispenser'], 'rx.override')).toBe(false)
    expect(can(['dispenser'], 'rx.reverse')).toBe(false)
    expect(roles.filter((r) => can([r], 'rx.override'))).toEqual(['pharmacist'])
    expect(roles.filter((r) => can([r], 'rx.reverse'))).toEqual(['pharmacist'])
    expect(roles.filter((r) => can([r], 'stock.adjust'))).toEqual(['manager'])
    expect(roles.filter((r) => can([r], 'users.manage'))).toEqual(['manager'])
    expect(can(['pharmacist', 'manager'], 'users.manage')).toBe(true)
    expect(Object.keys(rolePermissions)).toEqual([...roles])
  })
})

describe('1.4 counter assistants', () => {
  it('cannot open a patient, their allergies, scripts or the register, but can take payment at the till', async () => {
    const { patientId, scriptId } = await draftScript(p.t, { allergy: 'FAKEMOXIL' })
    for (const path of [`/dispensary/patients/${patientId}`, `/dispensary/scripts/${scriptId}`, '/dispensary', '/dispensary/register', '/reports/rx/patients']) {
      const res = await p.assistant.get(path)
      expect(res.status, path).toBe(403)
      expect(await res.text(), path).not.toContain('TESTPATIENT')
    }
    expect((await p.assistant.get('/api/till/scripts/1')).status).toBe(404)   // allowed, just no such script
    expect((await p.assistant.post(`/dispensary/scripts/${scriptId}/dispense`)).status).toBe(403)
    expect(await p.t.as(async (tx) => (await tx`select status from scripts where id = ${scriptId}`)[0].status)).toBe('draft')
  })

  it('does not see dispensary links in the menu', async () => {
    const html = await (await p.assistant.get('/')).text()
    expect(html).not.toContain('href="/dispensary"')
    expect(html).toContain('href="/till/"')
  })
})

describe('1.5 dispensers cannot override warnings', () => {
  it('can dispense a clean script', async () => {
    const { scriptId } = await draftScript(p.t)
    const res = await p.dispenser.post(`/dispensary/scripts/${scriptId}/dispense`)
    expect(new URL(res.headers.get('location')!, 'http://x').searchParams.get('ok')).toMatch(/Dispensed/)
  })

  it('cannot tick past an allergy warning; a pharmacist can', async () => {
    const { scriptId } = await draftScript(p.t, { allergy: 'FAKEMOXIL' })
    expect((await p.dispenser.post(`/dispensary/scripts/${scriptId}/dispense`, { confirmed: 'on' })).status).toBe(403)
    const page = await (await p.dispenser.get(`/dispensary/scripts/${scriptId}`)).text()
    expect(page).toContain('A pharmacist must dispense this script')
    expect(page).not.toContain('name="confirmed"')
    expect(await p.t.as(async (tx) => (await tx`select status from scripts where id = ${scriptId}`)[0].status)).toBe('draft')
    const ok = await p.pharmacist.post(`/dispensary/scripts/${scriptId}/dispense`, { confirmed: 'on' })
    expect(new URL(ok.headers.get('location')!, 'http://x').searchParams.get('ok')).toMatch(/Dispensed/)
  })

  it('cannot use the stock override', async () => {
    const { scriptId } = await draftScript(p.t)
    expect((await p.dispenser.post(`/dispensary/scripts/${scriptId}/dispense`, { allowNegative: 'on' })).status).toBe(403)
  })
})

describe('1.6 only pharmacists reverse scripts and remove allergies', () => {
  it('refuses a dispenser and a manager, allows a pharmacist', async () => {
    const { scriptId } = await draftScript(p.t)
    await p.pharmacist.post(`/dispensary/scripts/${scriptId}/dispense`)
    expect((await p.dispenser.post(`/dispensary/scripts/${scriptId}/reverse`, { reason: 'test' })).status).toBe(403)
    expect((await p.manager.post(`/dispensary/scripts/${scriptId}/reverse`, { reason: 'test' })).status).toBe(403)
    await p.pharmacist.post(`/dispensary/scripts/${scriptId}/reverse`, { reason: 'fake test reversal' })
    expect(await p.t.as(async (tx) => (await tx`select status from scripts where id = ${scriptId}`)[0].status)).toBe('reversed')
  })
})

describe('1.7 only managers adjust stock and manage users', () => {
  it('refuses a pharmacist a stock adjustment and a new login; allows a manager', async () => {
    const { itemId } = await draftScript(p.t)
    const level = () => p.t.as(async (tx) => (await tx`select on_hand_units from stock_levels where item_id = ${itemId}`)[0].on_hand_units)
    expect((await p.pharmacist.post(`/items/${itemId}/adjust`, { units: '-5', reason: 'DAMAGED' })).status).toBe(403)
    expect(await level()).toBe(100)
    await p.manager.post(`/items/${itemId}/adjust`, { units: '-5', reason: 'DAMAGED' })
    expect(await level()).toBe(95)
    const add = { name: 'Fake Person', email: `fake-${randomUUID().slice(0, 6)}@example.test`, password: 'fake-pass-123', role_assistant: 'on' }
    expect((await p.pharmacist.post('/users', add)).status).toBe(403)
    expect((await p.manager.post('/users', add)).status).toBe(302)
    expect(await p.t.as(async (tx) => (await tx`select roles from users where email = ${add.email}`)[0].roles)).toEqual(['assistant'])
  })
})
