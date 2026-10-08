import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/db/index.js'
import { createItem } from '../src/domain/items.js'
import { createApp } from '../src/web/app.js'
import { appDb, newTenant } from './helpers.js'

let db: Sql
beforeAll(() => { db = appDb() })
afterAll(async () => { await db.end() })

async function loggedIn() {
  const t = await newTenant(db)
  const app = createApp(db)
  const res = await app.request('/login', { method: 'POST', body: new URLSearchParams({ email: t.email, password: t.password }) })
  expect(res.status).toBe(302)
  const cookie = res.headers.get('set-cookie')!.split(';')[0]
  const get = (path: string) => app.request(path, { headers: { cookie } })
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
    for (const p of ['/', '/items', '/items/new', '/receiving', '/stocktakes', '/reports', '/reports/minmax', '/reports/minmax/suggest',
      '/reports/valuation', '/reports/negative', '/reports/dormant', '/reports/adjustments', '/reports/gp', '/reports/quarantine', '/settings']) {
      const res = await get(p)
      expect(res.status, p).toBe(200)
    }
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
})
