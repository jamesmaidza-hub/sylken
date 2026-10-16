import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/db/index.js'
import { createItem, getItem } from '../src/domain/items.js'
import { createApp } from '../src/web/app.js'
import { appDb, newTenant, webLogin } from './helpers.js'

let db: Sql
beforeAll(() => { db = appDb() })
afterAll(async () => { await db.end() })

async function loggedIn() {
  const t = await newTenant(db)
  const app = createApp(db)
  // The owner is a pharmacist, so the dispensary also needs their 2-letter code, which the screens keep in a cookie.
  const cookie = `${await webLogin(app, t.email, t.password)}; rx_code=${t.staffCode}`
  const get =(path: string) => app.request(path, { headers: { cookie } })
  const post = (path: string, body: Record<string, string>) => app.request(path, { method: 'POST', headers: { cookie }, body: new URLSearchParams(body) })
  return { t, app, cookie, get, post }
}

describe('web', () => {
  it('sends people without a session to the login page', async () => {
    const app = createApp(db)
    expect((await app.request('/items')).headers.get('location')).toBe('/login')
    expect((await app.request('/api/items')).status).toBe(401)
    const bad = await app.request('/login', { method: 'POST', body: new URLSearchParams({ email: 'x@y.z', password: 'nope' }) })
    expect(bad.headers.get('location')).toMatch(/err=/)
  })

  it('serves every screen once logged in', async () => {
    const { get } = await loggedIn()
    for (const p of ['/', '/menu/stock', '/menu/dispensary', '/menu/sales', '/items', '/items/new', '/receiving', '/stocktakes', '/reports', '/reports/minmax', '/reports/minmax/suggest', '/items/velocity',
      '/reports/valuation', '/reports/negative', '/reports/dormant', '/reports/adjustments', '/reports/gp', '/reports/quarantine', '/settings',
      '/till/', '/till/app.js', '/till/sw.js', '/cashup', '/cashup/problems', '/sales', '/accounts', '/accounts/aging', '/reports/sales', '/reports/sales-gp',
      '/reports/sales?format=csv', '/reports/sales-gp?format=csv', '/dispensary', '/dispensary?q=smith', '/dispensary/patients/new',
      '/dispensary/scripts', '/dispensary/scripts?format=csv', '/dispensary/owed', '/dispensary/register', '/dispensary/register?format=csv',
      '/dispensary/doctors', '/dispensary/dispensers', '/dispensary/settings', '/dispensary/scripts?format=xlsx', '/dispensary/register?format=xlsx', '/reports/rx', '/sales?from=2026-01-01']) {
      const res = await get(p)
      expect(res.status, p).toBe(200)
    }
  })

  it('adds a dispenser with a staff code from the Dispensary menu', async () => {
    const { t, get, post } = await loggedIn()
    const menu = await (await get('/menu/dispensary')).text()
    expect(menu).toContain('href="/dispensary/dispensers"')                                 // the Dispensers tab is in the Dispensary menu
    const res = await post('/dispensary/dispensers', { name: 'Pula Dube', staffCode: 'pd', email: 'pula.dube@example.test', password: 'fake-pass-123' })
    expect(new URL(res.headers.get('location')!, 'http://x').searchParams.get('ok')).toBe('Dispenser added')
    const page = await (await get('/dispensary/dispensers')).text()
    expect(page).toContain('Pula Dube')
    expect(page).toContain('>PD<')                                                          // the code is kept in capitals
    expect(await t.as((tx) => tx`select roles, staff_code from users where email = 'pula.dube@example.test'`)).toMatchObject([{ roles: ['dispenser'], staff_code: 'PD' }])
    // Another person cannot take the same code, and a code is required.
    expect(new URL((await post('/dispensary/dispensers', { name: 'Pat Dee', staffCode: 'PD', email: 'pat@example.test', password: 'fake-pass-123' })).headers.get('location')!, 'http://x').searchParams.get('err')).toMatch(/already belongs to Pula Dube/)
    expect(new URL((await post('/dispensary/dispensers', { name: 'No Code', staffCode: '', email: 'nc@example.test', password: 'fake-pass-123' })).headers.get('location')!, 'http://x').searchParams.get('err')).toMatch(/staff code/)
  })

  it('serves every dispensary report on screen, as CSV and as Excel', async () => {
    const { get } = await loggedIn()
    for (const p of ['/reports/rx/drug-usage', '/reports/rx/scripts', '/reports/rx/scripts?by=aid', '/reports/rx/scripts?by=doctor',
      '/reports/rx/scripts?by=dispenser', '/reports/rx/patients', '/reports/rx/patients?all=on&aid=private', '/reports/rx/last-visit',
      '/reports/rx/repeats', '/reports/rx/price-changes', '/reports/rx/reversed',
      '/reports/till/statements', '/reports/till/debtors', '/reports/till/account-transactions', '/reports/till/journal', '/reports/till/detail',
      '/reports/till/assistants', '/reports/till/petty-cash', '/reports/till/price-alterations', '/reports/till/markup?below=10', '/reports/till/otc',
      '/reports/till/contacts?phone=on', '/reports/till/audit', '/reports/sales', '/reports/sales-gp']) {
      expect((await get(p)).status, p).toBe(200)
      const sep = p.includes('?') ? '&' : '?'
      const c = await get(`${p}${sep}format=csv`)
      expect(c.headers.get('content-type'), p).toMatch(/text\/csv/)
      const x = await get(`${p}${sep}format=xlsx&from=2026-01-01&to=2026-01-31`)
      expect(x.headers.get('content-disposition'), p).toMatch(/\.xlsx/)
      expect(Buffer.from(await x.arrayBuffer()).subarray(0, 2).toString(), p).toBe('PK')
    }
  })

  it('starts a new patient from a search as active, with the surname filled in', async () => {
    const { get } = await loggedIn()
    const html = await (await get('/dispensary/patients/new?surname=kgosi')).text()
    expect(html).toContain('value="KGOSI"')
    expect(html).not.toContain('name="inactive"')
  })

  it('lists items the shop carries before dormant catalogue items', async () => {
    const { t, get } = await loggedIn()
    await t.as(async (tx) => {
      await createItem(tx, { stockCode: 'D1', description: 'AAA AMOXIL OLD', costPerPack: 5, status: 'dormant' })
      await createItem(tx, { stockCode: 'A1', description: 'ZZZ AMOXIL NEW', costPerPack: 5 })
    })
    const html = await (await get('/items?q=amoxil')).text()
    expect(html.indexOf('ZZZ AMOXIL NEW')).toBeLessThan(html.indexOf('AAA AMOXIL OLD'))
  })

  it('lists items under their bins in shelf order, with a filter and items with no bin last', async () => {
    const { t, get } = await loggedIn()
    await t.as(async (tx) => {
      await createItem(tx, { stockCode: 'B10', description: 'TEN SHELF ITEM', costPerPack: 5, bins: ['a10'] })
      await createItem(tx, { stockCode: 'B2', description: 'TWO SHELF ITEM', costPerPack: 5, bins: ['A2', 'A10'] })
      await createItem(tx, { stockCode: 'B0', description: 'LOOSE ITEM', costPerPack: 5 })
    })
    const html = await (await get('/items/bins')).text()
    expect(html.indexOf('Bin A2')).toBeGreaterThan(-1)
    expect(html.indexOf('Bin A2')).toBeLessThan(html.indexOf('Bin A10'))
    expect(html.indexOf('Bin A10')).toBeLessThan(html.lastIndexOf('No bin yet'))
    const a10 = await (await get('/items/bins?bin=A10')).text()
    expect(a10).toContain('TEN SHELF ITEM')
    expect(a10).toContain('TWO SHELF ITEM')
    expect(a10).not.toContain('LOOSE ITEM')
    expect(await (await get('/items/bins?bin=-')).text()).toContain('LOOSE ITEM')
  })

  it('starts the bins folded and moves several ticked items to another bin without touching stock', async () => {
    const { t, app, cookie, get } = await loggedIn()
    const [a, b] = await t.as(async (tx) => [
      await createItem(tx, { stockCode: 'M1', description: 'MOVE ONE', costPerPack: 5, bins: ['A1', 'Z9'] }),
      await createItem(tx, { stockCode: 'M2', description: 'MOVE TWO', costPerPack: 5 }),
    ])
    const html = await (await get('/items/bins')).text()
    expect(html).toContain('<details class="bin-group" data-bin="A1">')
    expect(html).toContain('id="move-form"')
    const body = new URLSearchParams([['move', `A1|${a.id}`], ['move', `-|${b.id}`], ['to', 'c3'], ['back', '/items/bins']])
    const res = await app.request('/items/bins/move', { method: 'POST', headers: { cookie }, body })
    const loc = new URL(res.headers.get('location')!, 'http://x')
    expect([loc.pathname, loc.searchParams.get('open'), loc.searchParams.get('ok')]).toEqual(['/items/bins', 'C3', 'Moved 2 items to bin C3'])
    const after = await t.as(async (tx) => [await getItem(tx, a.id), await getItem(tx, b.id)])
    expect(after[0]!.bins).toEqual(['C3', 'Z9'])
    expect(after[1]!.bins).toEqual(['C3'])
    expect(after[0]!.onHandUnits).toBe(a.onHandUnits)
    const logs = await t.as((tx) => tx`select entity_id from audit_log where action = 'item.bin_move'`)
    expect(logs.map((r: any) => r.entity_id).sort()).toEqual([a.id, b.id].sort())
  })

  it('saves till quick buttons and sends them to the till', async () => {
    const { t, get, post } = await loggedIn()
    await t.as((tx) => createItem(tx, { stockCode: 'W500', description: 'WATER 500ML', costPerPack: 3 }))
    const bad = await post('/settings/till-buttons', { buttons: 'NOPE, Nothing, red' })
    expect(decodeURIComponent(bad.headers.get('location')!)).toMatch(/NOPE/)
    await post('/settings/till-buttons', { buttons: 'W500, Water, blue\n' })
    const cat = await (await get('/api/till/catalogue')).json()
    expect(cat.tenant.buttons).toEqual([{ code: 'W500', label: 'Water', color: 'blue' }])
  })

  it('keeps a NAPPI code on an item and finds the item by it', async () => {
    const { t, get } = await loggedIn()
    const item = await t.as((tx) => createItem(tx, { stockCode: 'AMX500', description: 'AMOXIL 500', costPerPack: 5, nappiCode: '708001-001' }))
    expect((await get('/items?q=708001-001')).headers.get('location')).toBe(`/items/${item.id}`)
    const cat = await (await get('/api/till/catalogue')).json()
    expect(cat.items.find((i: any) => i.c === 'AMX500').x).toBe('708001-001')
    await expect(t.as((tx) => createItem(tx, { stockCode: 'BAD', description: 'X', nappiCode: 'abc' }))).rejects.toThrow(/NAPPI/)
  })

  it('goes straight to the item when a barcode is scanned into search', async () => {
    const { t, get } = await loggedIn()
    const item = await t.as((tx) => createItem(tx, { stockCode: '6005894000352', description: 'COUGH SYRUP', costPerPack: 10 }))
    const res = await get('/items?q=6005894000352')
    expect(res.headers.get('location')).toBe(`/items/${item.id}`)
  })

  it('shows domain errors back on the form instead of failing', async () => {
    const { post } = await loggedIn()
    const res = await post('/items', { stockCode: 'X1', description: 'Bad', costPerPack: '99999999', packSize: '1' })
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location')!, 'http://x').searchParams.get('err')).toMatch(/outside the allowed range/)
  })

  it('accepts till movements over the API exactly once', async () => {
    const { t, app, cookie } = await loggedIn()
    const item = await t.as((tx) => createItem(tx, { stockCode: 'TILL1', description: 'Till item', costPerPack: 10 }))
    const body = JSON.stringify({ movements: [{ id: crypto.randomUUID(), itemId: item.id, kind: 'sale', qtyUnits: -2, occurredAt: new Date().toISOString() }] })
    const send = () => app.request('/api/movements', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body })
    expect(await (await send()).json()).toEqual({ recorded: 1, duplicates: 0 })
    expect(await (await send()).json()).toEqual({ recorded: 0, duplicates: 1 })
  })

  it('runs a till over the API: catalogue, sync once, cash-up on screen', async () => {
    const { t, app, cookie, get, post } = await loggedIn()
    const item = await t.as((tx) => createItem(tx, { stockCode: '6001', description: 'PANADO 24', packSize: 24, sellLoose: true, costPerPack: 10, barcodes: ['6009876543210'] }))
    const cat = await (await get('/api/till/catalogue')).json() as any
    const it = cat.items.find((x: any) => x.i === item.id)
    expect(it).toMatchObject({ c: '6001', p: 17.1, n: 24, l: true, b: ['6009876543210'] })
    expect(cat.tenant).toMatchObject({ cashRounding: 0.05, vatRate: 0.14 })
    const tillId = cat.tills[0].id
    const runId = crypto.randomUUID()
    const saleId = crypto.randomUUID()
    const now = new Date().toISOString()
    const body = JSON.stringify({ tillId, pending: 3, runIds: [runId], ops: [
      { type: 'open_run', userId: cat.user.id, data: { id: runId, tillId, openingFloat: 100, openedAt: now } },
      { type: 'sale', userId: cat.user.id, data: { id: saleId, runId, kind: 'sale', occurredAt: now, cashTendered: 50, cashierCode: t.staffCode,
        lines: [{ itemId: item.id, qtyUnits: 24, listTotal: 17.1, lineTotal: 17.1 }], payments: [{ tender: 'cash', amount: 17.1 }] } },
      { type: 'sale', data: { id: 'not-a-uuid' } },
    ] })
    const send = async () => (await app.request('/api/till/sync', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body })).json() as any
    const first = await send()
    expect(first.results.map((r: any) => r.status)).toEqual(['recorded', 'recorded', 'rejected'])
    expect(first.runs[runId]).toEqual({ runNo: expect.any(Number), status: 'open' })
    const again = await send()
    expect(again.results.map((r: any) => r.status)).toEqual(['duplicate', 'duplicate', 'rejected'])

    expect(await (await get(`/sales/${saleId}`)).text()).toContain('PANADO 24')
    const slip = await (await get(`/sales/${saleId}/slip`)).text()
    expect(slip).toContain('TAX INVOICE · COPY')
    expect(slip).toContain('PANADO 24')
    expect(await (await get(`/cashup/runs/${runId}`)).text()).toContain('Cash up this run')
    // The cash is counted in notes and coins: P100 + P10 + P5 + P2 + 10t = P117.10.
    const closed = await post(`/cashup/runs/${runId}/close`, { d_100: '1', d_10: '1', d_5: '1', d_2: '1', 'd_0.1': '1', card: '0', cheque: '0', floatKept: '100', note: '' })
    const closedTo = new URL(closed.headers.get('location')!, 'http://x')
    expect(closedTo.searchParams.get('ok')).toMatch(/balances/)
    expect(closedTo.pathname).toBe(`/cashup/runs/${runId}/z`)                 // cashing up lands on the Z-report
    const zPage = await (await get(`/cashup/runs/${runId}/z`)).text()
    expect(zPage).toContain('Z-report 1')
    expect(zPage).toContain('Notes and coins counted')
    const zJson = await (await get(`/cashup/runs/${runId}/z?format=json`)).json() as any
    expect(zJson).toMatchObject({ zNo: 1, runNo: expect.any(Number), totalVariance: 0, cashBreakdown: { '100': 1, '10': 1, '5': 1, '2': 1, '0.1': 1 } })
    const after = await send()
    expect(after.runs[runId].status).toBe('closed')
    expect(await (await get('/cashup/problems')).text()).toContain('not-a-uuid')
  })

  it('dispenses a script on screen, prints its labels and finds it from the till', async () => {
    const { t, app, cookie, get, post } = await loggedIn()
    const loc = (res: Response) => new URL(res.headers.get('location')!, 'http://x')
    await t.as((tx) => createItem(tx, { stockCode: 'AMX500', description: 'AMOXICILLIN 500MG CAPS', packSize: 15, sellLoose: true, costPerPack: 30 }))
    await t.as(async (tx) => {
      const [i] = await tx`select id from items where stock_code = 'AMX500'`
      await tx`insert into stock_movements (tenant_id, item_id, kind, qty_units) values (${t.id}, ${i.id}, 'opening', 60)`
    })
    expect(loc(await post('/dispensary/settings', { fee: '10', supplyDays: '30', repeatDays: '180', schedules: '2, 3', nextNo: '61370',
      labelW: '70', labelH: '36', labelFooter: 'Keep out of reach of children', address: 'Main Mall, Gaborone', phone: '391 0000' })).searchParams.get('ok')).toBe('Settings saved')
    await post('/dispensary/settings/aids', { name: 'BOMAid', code: 'BOM' })
    await post('/dispensary/doctors', { surname: 'Molefe', initials: 'K', title: 'Dr', practiceNo: 'P-1', phone: '' })
    const html = await (await get('/dispensary/patients/new')).text()
    const aidId = html.match(/<option value="([0-9a-f-]{36})">BOMAid/)![1]
    const created = await post('/dispensary/patients', { surname: 'Mothibi', firstNames: 'Kagiso', medicalAidId: aidId, memberNo: '12345', sex: 'F' })
    const patientPath = loc(created).pathname
    const docId = (await (await get(patientPath)).text()).match(/<option value="([0-9a-f-]{36})">Dr K Molefe/)![1]
    // Nothing in the dispensary opens without a real dispenser code.
    const wrongCode = `${cookie.split(';')[0]}; rx_code=QQ`
    const gated = await app.request('/dispensary', { headers: { cookie: wrongCode } })
    expect(await gated.text()).toContain('Your 2-letter dispenser code')
    expect((await app.request(`${patientPath}/scripts`, { method: 'POST', headers: { cookie: wrongCode }, body: new URLSearchParams({ rxDate: '2020-01-01' }) })).headers.get('location')).toMatch(/dispenser%20code%20first|dispenser\+code\+first/)
    const draft = await post(`${patientPath}/scripts`, { doctorId: docId, rxDate: new Date().toISOString().slice(0, 10) })
    const scriptPath = loc(draft).pathname
    await post('/settings/rx-buttons', { buttons: 'AMX500, Amoxil 500, teal' })
    const touch = await (await get(scriptPath)).text()
    expect(touch).toContain('data-code="AMX500"')
    expect(touch).toContain('Amoxil 500')
    expect(touch).toContain('id="finder"')
    expect(loc(await post(`${scriptPath}/lines`, { item: 'amoxicillin', qty: '2', per: 'packs', supply: '', directions: '1c3d', supplyDays: '10', repeats: '1', icd10: 'j06.9' })).pathname).toBe(scriptPath)
    const page = await (await get(scriptPath)).text()
    expect(page).toContain('Take ONE capsule THREE times a day')
    expect(page).toContain('J06.9')
    const done = await post(`${scriptPath}/dispense`, {})
    expect(loc(done).searchParams.get('ok')).toMatch(/script 61370/)
    const labels = await (await get(`${scriptPath}/labels`)).text()
    expect(labels).toContain('KAGISO MOTHIBI')
    expect(labels).toContain('Main Mall, Gaborone')
    expect(labels).toContain('size:70mm 36mm')
    const till = await (await get('/api/till/scripts/61370')).json() as any
    expect(till).toMatchObject({ scriptNo: 61370, medicalAid: 'BOMAid', memberNo: '12345/00', status: 'dispensed', paid: 0 })
    expect(till.lines[0]).toMatchObject({ qtyUnits: 30 })
    expect((await get('/api/till/scripts/99999')).status).toBe(404)
    expect(loc(await get('/dispensary/scripts?no=61370')).pathname).toBe(scriptPath)
    expect(await (await get(`/dispensary/scripts?from=2000-01-01&to=2100-01-01`)).text()).toContain('KAGISO MOTHIBI')
    expect(loc(await post(`${scriptPath}/repeat`, {})).pathname).toMatch(/^\/dispensary\/scripts\//)
  })
})
