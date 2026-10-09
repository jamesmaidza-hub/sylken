import { Hono } from 'hono'
import { z } from 'zod'
import { DomainError } from '../domain/errors.js'
import { findByCode, searchItems } from '../domain/items.js'
import { getSettings } from '../domain/settings.js'
import { postMovements } from '../domain/stock.js'
import { scriptForTill } from '../domain/scripts.js'
import { applyTillOps, drawerTenders, tenders, touchTill } from '../domain/till.js'
import { run, type Env } from './app.js'

/**
 * JSON API: item lookup, raw stock movements, and the till's catalogue and sync. Everything a
 * device sends carries an id it made itself, so re-sending something that already arrived does nothing.
 */
const movementSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
  kind: z.enum(['sale', 'sale_return', 'dispense']),
  qtyUnits: z.number().int().refine((n) => n !== 0),
  unitRetail: z.number().nullable().optional(),
  deviceId: z.string().max(64).optional(),
  occurredAt: z.string().datetime(),
})

const when = z.string().datetime({ offset: true }).transform((s) => new Date(s))
const money = z.number().finite()
const opSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open_run'), userId: z.string().uuid().nullish(), data: z.object({
    id: z.string().uuid(), tillId: z.string().uuid(), openingFloat: money, openedAt: when,
  }) }),
  z.object({ type: z.literal('sale'), userId: z.string().uuid().nullish(), data: z.object({
    id: z.string().uuid(), runId: z.string().uuid(), kind: z.enum(['sale', 'refund']), refundOf: z.string().uuid().nullish(),
    occurredAt: when, accountId: z.string().uuid().nullish(), medicalAid: z.string().max(80).nullish(), memberNo: z.string().max(40).nullish(),
    cashTendered: money.nullish(), rounding: money.nullish(), scriptId: z.string().uuid().nullish(),
    lines: z.array(z.object({ itemId: z.string().uuid(), qtyUnits: z.number().int(), listTotal: money, lineTotal: money,
      scriptLineId: z.string().uuid().nullish() })).max(500),
    payments: z.array(z.object({ tender: z.enum(tenders), amount: money, reference: z.string().max(60).nullish() })).max(10),
  }) }),
  z.object({ type: z.literal('till_entry'), userId: z.string().uuid().nullish(), data: z.object({
    id: z.string().uuid(), runId: z.string().uuid(), kind: z.enum(['petty_cash', 'account_payment']), tender: z.enum(drawerTenders),
    amount: money, accountId: z.string().uuid().nullish(), note: z.string().max(200).nullish(), occurredAt: when,
  }) }),
])
const syncSchema = z.object({
  tillId: z.string().uuid(),
  deviceId: z.string().max(64).nullish(),
  pending: z.number().int().nonnegative().nullish(),
  runIds: z.array(z.string().uuid()).max(20).default([]),
  ops: z.array(z.unknown()).max(200),
})

export function api() {
  const r = new Hono<Env>()

  r.get('/items/lookup', async (c) => {
    const item = await run(c, (tx) => findByCode(tx, c.req.query('code') ?? ''))
    return item ? c.json(item) : c.json({ error: 'not found' }, 404)
  })

  r.get('/items', async (c) => {
    const items = await run(c, (tx) => searchItems(tx, c.req.query('q') ?? '', { limit: 25 }))
    return c.json(items)
  })

  r.post('/movements', async (c) => {
    const parsed = z.object({ movements: z.array(movementSchema).max(500) }).safeParse(await c.req.json())
    if (!parsed.success) throw new DomainError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    // Sales that happened offline are already done; record them even if stock would go negative.
    const recorded = await run(c, (tx) => postMovements(tx, parsed.data.movements.map((m) => ({
      ...m, occurredAt: new Date(m.occurredAt),
    })), { userId: c.get('user').userId, allowNegative: true }))
    return c.json({ recorded: recorded.length, duplicates: parsed.data.movements.length - recorded.length })
  })

  /** Everything a till needs to keep selling without the server: items, prices, barcodes and accounts. */
  r.get('/till/catalogue', async (c) => {
    const user = c.get('user')
    const data = await run(c, async (tx) => {
      const settings = await getSettings(tx)
      const items = await tx`
        select i.id, i.stock_code, i.description, i.retail_per_pack, i.pack_size, i.sell_loose, i.status, i.vat_rate,
               coalesce((select array_agg(b.barcode) from item_barcodes b where b.item_id = i.id), '{}') as barcodes
          from items i where i.status in ('active','dormant') order by i.description`
      const accounts = await tx`
        select a.id, a.account_no, a.name, a.credit_limit,
               coalesce((select sum(e.amount) from account_entries e where e.account_id = a.id), 0) as balance
          from customer_accounts a where a.active order by a.name`
      const tills = await tx`select id, code, name from tills where active order by code`
      return {
        tenant: { id: user.tenantId, name: user.tenantName, vatNumber: settings.vatNumber, receiptFooter: settings.receiptFooter, defaultFloat: settings.defaultFloat, cashRounding: settings.cashRounding, vatRate: settings.vatRate },
        user: { id: user.userId, name: user.name, role: user.role },
        tills: tills.map((t) => ({ id: t.id, code: t.code, name: t.name })),
        accounts: accounts.map((a) => ({
          id: a.id, no: a.account_no, name: a.name, balance: Number(a.balance), limit: a.credit_limit === null ? null : Number(a.credit_limit),
        })),
        items: items.map((i) => ({
          i: i.id, c: i.stock_code, d: i.description, p: Number(i.retail_per_pack), n: i.pack_size, l: i.sell_loose,
          ...(i.barcodes.length ? { b: i.barcodes } : {}), ...(i.vat_rate !== null ? { v: Number(i.vat_rate) } : {}), ...(i.status === 'dormant' ? { z: 1 } : {}),
        })),
        at: new Date().toISOString(),
      }
    })
    return c.json(data)
  })

  /** A dispensed script, found by its number, so the till can take payment for it. Needs the server. */
  r.get('/till/scripts/:no', async (c) => {
    const no = Number(c.req.param('no'))
    const script = Number.isInteger(no) ? await run(c, (tx) => scriptForTill(tx, no)) : null
    return script ? c.json(script) : c.json({ error: `no script number ${c.req.param('no')}` }, 404)
  })

  /**
   * A till sends what it recorded (runs opened, sales, petty cash, account payments) in the
   * order it happened. Each is recorded once; anything that can't be recorded comes back as
   * rejected with the reason and is kept for the back office. The reply also says which of
   * the till's runs have been cashed up.
   */
  r.post('/till/sync', async (c) => {
    const parsed = syncSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new DomainError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    const body = parsed.data
    const user = c.get('user')
    const out = await run(c, async (tx) => {
      const [till] = await tx`select id from tills where id = ${body.tillId}`
      if (!till) throw new DomainError('unknown till', 'not_found', 404)
      const ops: any[] = []
      const results: any[] = []
      // Validate each operation on its own, so one malformed entry is rejected rather than the whole batch.
      const shaped = body.ops.map((raw) => {
        const p = opSchema.safeParse(raw)
        return p.success ? { ok: true as const, op: p.data } : { ok: false as const, raw, error: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
      })
      for (const s of shaped) if (s.ok) ops.push(s.op)
      const applied = await applyTillOps(tx, body.tillId, ops, user.userId, body.deviceId)
      let k = 0
      for (const s of shaped) {
        if (s.ok) results.push(applied[k++])
        else {
          await tx`insert into till_rejects (tenant_id, till_id, op, error) values (current_setting('app.tenant_id')::uuid, ${body.tillId}, ${tx.json(s.raw as any)}, ${s.error})`
          results.push({ id: (s.raw as any)?.data?.id ?? null, status: 'rejected', error: s.error })
        }
      }
      await touchTill(tx, body.tillId, Math.max(0, (body.pending ?? 0) - results.filter((x) => x.status !== 'rejected').length))
      const runIds = [...new Set([...body.runIds, ...ops.filter((o) => o.type === 'open_run').map((o) => o.data.id)])]
      const runs = runIds.length ? await tx`select id, run_no, status from till_runs where id = any(${runIds}::uuid[])` : []
      return { results, runs: Object.fromEntries(runs.map((r) => [r.id, { runNo: r.run_no, status: r.status }])) }
    })
    return c.json(out)
  })

  return r
}
