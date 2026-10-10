import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/db/index.js'
import { createAccount, postAccountEntry } from '../src/domain/accounts.js'
import { createItem, updateItem } from '../src/domain/items.js'
import { createPatient } from '../src/domain/patients.js'
import { shopToday } from '../src/domain/sales.js'
import { postMovements } from '../src/domain/stock.js'
import { listTills, openRun, recordSale, recordTillEntry } from '../src/domain/till.js'
import {
  accountStatements, accountTransactions, assistantSales, auditLog, contacts, debtors, markupReport, otcSales, pettyCash, salesDetail,
  salesJournal, tillPriceAlterations,
} from '../src/domain/tillreports.js'
import { appDb, newTenant } from './helpers.js'

let db: Sql
let t: Awaited<ReturnType<typeof newTenant>>
beforeAll(async () => { db = appDb(); t = await newTenant(db) })
afterAll(async () => { await db.end() })

const today = () => shopToday('Africa/Gaborone')
const range = () => ({ from: today(), to: today() })

describe('till reports', () => {
  it('reports accounts, sales, assistants, petty cash and price alterations from what the till recorded', async () => {
    const { item, acc, run } = await t.as(async (tx) => {
      const item = await createItem(tx, { stockCode: 'VITC', description: 'VITAMIN C 1000', packSize: 1, costPerPack: 20 })   // retail 34.20
      await postMovements(tx, [{ itemId: item.id, kind: 'opening', qtyUnits: 50 }])
      const acc = await createAccount(tx, { accountNo: 'A1', name: 'KGOSI TRADING', phone: '3900000', creditLimit: 100 })
      const run = randomUUID()
      await openRun(tx, { id: run, tillId: (await listTills(tx))[0].id, openingFloat: 100, openedAt: new Date() })
      return { item, acc, run }
    })
    // Opening balance from a correction made before the range.
    await t.as((tx) => postAccountEntry(tx, acc, { kind: 'adjustment', amount: 40, note: 'Brought forward' }, t.userId))
    await t.as((tx) => tx`update account_entries set occurred_at = now() - interval '40 days' where account_id = ${acc}`)
    await t.as(async (tx) => {
      await recordSale(tx, { id: randomUUID(), runId: run, kind: 'sale', occurredAt: new Date(), accountId: acc,
        lines: [{ itemId: item.id, qtyUnits: 2, listTotal: 68.4, lineTotal: 68.4 }], payments: [{ tender: 'account', amount: 68.4 }] }, { userId: t.userId })
      await recordSale(tx, { id: randomUUID(), runId: run, kind: 'sale', occurredAt: new Date(), cashTendered: 30,
        lines: [{ itemId: item.id, qtyUnits: 1, listTotal: 34.2, lineTotal: 30 }], payments: [{ tender: 'cash', amount: 30 }] }, { userId: t.userId })
      await recordTillEntry(tx, { id: randomUUID(), runId: run, kind: 'account_payment', tender: 'cash', amount: 50, accountId: acc, occurredAt: new Date() }, { userId: t.userId })
      await recordTillEntry(tx, { id: randomUUID(), runId: run, kind: 'petty_cash', tender: 'cash', amount: 12.5, note: 'Milk', occurredAt: new Date() }, { userId: t.userId })
    })

    const [st] = await t.as((tx) => accountStatements(tx, range()))
    expect(st).toMatchObject({ accountNo: 'A1', opening: 40, charged: 68.4, paid: 50, closing: 58.4 })
    expect(st.lines.map((l) => [l.what, l.balance])).toEqual([[expect.stringMatching(/^Sale \d+$/), 108.4], ['Payment at the till', 58.4]])

    const tr = await t.as((tx) => accountTransactions(tx, range()))
    expect(tr.map((x) => [x.kind, x.where.startsWith('Till'), x.charged, x.paid])).toEqual([['charge', true, 68.4, 0], ['payment', true, 0, 50]])
    expect(await t.as((tx) => accountTransactions(tx, range(), { kind: 'adjustment' }))).toEqual([])

    const [d] = await t.as((tx) => debtors(tx, today()))
    expect(d).toMatchObject({ balance: 58.4, phone: '3900000', overLimit: false })
    expect(d.lastPayment).not.toBeNull()

    const j = await t.as((tx) => salesJournal(tx, range()))
    expect(j.map((x) => [x.total, x.discount, x.tenders])).toEqual([[68.4, 0, 'account 68.40'], [30, 4.2, 'cash 30.00']])
    expect((await t.as((tx) => salesDetail(tx, range(), { q: 'vitamin' }))).length).toBe(2)

    const alt = await t.as((tx) => tillPriceAlterations(tx, range()))
    expect(alt).toMatchObject([{ list: 34.2, total: 30, discount: 4.2, changePct: -12.28 }])

    const [a] = await t.as((tx) => assistantSales(tx, range()))
    expect(a).toMatchObject({ name: 'Owner', sales: 2, units: 3, total: 98.4, discount: 4.2, accountPayments: 50, pettyCash: 12.5, perSale: 49.2 })

    expect(await t.as((tx) => pettyCash(tx, range()))).toMatchObject([{ amount: 12.5, note: 'Milk', by: 'Owner' }])
    expect(await t.as((tx) => otcSales(tx, range()))).toMatchObject([{ stockCode: 'VITC', sales: 2, units: 3, total: 98.4 }])
  })

  it('shows markup, contacts and the audit log', async () => {
    const i = await t.as((tx) => createItem(tx, { stockCode: 'LOW', description: 'LOW MARKUP', packSize: 1, costPerPack: 100 }, t.userId))
    await t.as((tx) => updateItem(tx, i.id, { retailPerPack: 120 }, t.userId))
    const low = await t.as((tx) => markupReport(tx, { below: 10 }))
    expect(low.map((x) => x.stockCode)).toEqual(['LOW'])
    expect(low[0]).toMatchObject({ markupIncl: 20, rulePrice: 171, difference: -51, setMarkup: 50 })
    expect((await t.as((tx) => markupReport(tx, { offRule: true }))).map((x) => x.stockCode)).toEqual(['LOW'])

    await t.as((tx) => createPatient(tx, { surname: 'ZULU', firstNames: 'Ama', phone: '71234567' }))
    await t.as((tx) => createPatient(tx, { surname: 'ZWANE' }))
    const c = await t.as((tx) => contacts(tx, { kind: 'patient', withPhone: true }))
    expect(c.map((x) => [x.name, x.phone])).toEqual([['AMA ZULU', '71234567']])

    const log = await t.as((tx) => auditLog(tx, range(), { entity: 'item' }))
    expect(log.map((x) => x.action)).toEqual(expect.arrayContaining(['create', 'update']))
    expect(log[0].href).toBe(`/items/${i.id}`)
  })
})
