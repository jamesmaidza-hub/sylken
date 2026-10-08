import { Hono } from 'hono'
import { z } from 'zod'
import { DomainError } from '../domain/errors.js'
import { findByCode, searchItems } from '../domain/items.js'
import { postMovements } from '../domain/stock.js'
import { run, type Env } from './app.js'

/**
 * JSON API. Small for now: item lookup and posting stock movements. The till (stage 2)
 * records sales offline with its own movement ids and sends them here when it reconnects;
 * re-sending a movement that already arrived does nothing.
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

  return r
}
