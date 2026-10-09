import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Sql, Tx } from '../db/index.js'
import { num, withTenant } from '../db/index.js'
import { login, logout, sessionUser, type SessionUser } from '../domain/auth.js'
import { DomainError } from '../domain/errors.js'
import { api } from './api.js'
import { itemRoutes } from './items.js'
import { Layout } from './layout.js'
import { receivingRoutes } from './receiving.js'
import { reportRoutes } from './reports.js'
import { settingsRoutes } from './settings.js'
import { stockTakeRoutes } from './stocktakes.js'
import { accountRoutes } from './accounts.js'
import { cashupRoutes } from './cashup.js'
import { salesRoutes } from './sales.js'
import { tillRoutes } from './till.js'
import { dispensaryRoutes } from './dispensary.js'
import * as reports from '../domain/reports.js'
import { money } from './layout.js'

export type Env = { Variables: { user: SessionUser; db: Sql } }
export type Ctx = Context<Env>

const COOKIE = 'sylken_session'

/** Run fn as the logged-in user's pharmacy. */
export function run<T>(c: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(c.get('db'), c.get('user').tenantId, fn)
}

export function flash(c: Ctx) {
  return { ok: c.req.query('ok'), err: c.req.query('err') }
}

export function back(c: Ctx, path: string, msg: { ok?: string; err?: string }) {
  const q = new URLSearchParams()
  if (msg.ok) q.set('ok', msg.ok)
  if (msg.err) q.set('err', msg.err)
  return c.redirect(`${path}${path.includes('?') ? '&' : '?'}${q}`)
}

export function requireRole(c: Ctx, roles: SessionUser['role'][]) {
  if (!roles.includes(c.get('user').role)) throw new DomainError(`this needs a ${roles.join(' or ')} login`, 'forbidden', 403)
}

export function page(c: Ctx, title: string, body: any) {
  return c.html(<Layout title={title} user={c.get('user')} path={c.req.path} flash={flash(c)}>{body}</Layout>)
}

export function createApp(db: Sql) {
  const app = new Hono<Env>()

  app.use('*', async (c, next) => { c.set('db', db); await next() })

  app.get('/health', (c) => c.text('ok'))

  app.get('/login', (c) =>
    c.html(
      <Layout title="Log in" flash={{ err: c.req.query('err') }}>
        <div class="panel" style="max-width:360px;margin:10vh auto">
          <h1>sylken</h1>
          <form method="post" action="/login" style="display:grid;gap:10px">
            <label class="f">Email<input name="email" type="email" autofocus required autocomplete="username" /></label>
            <label class="f">Password<input name="password" type="password" required autocomplete="current-password" /></label>
            <button type="submit">Log in</button>
          </form>
        </div>
      </Layout>,
    ),
  )

  app.post('/login', async (c) => {
    const body = await c.req.parseBody()
    const token = await login(db, String(body.email ?? ''), String(body.password ?? ''))
    if (!token) return c.redirect('/login?err=' + encodeURIComponent('Wrong email or password'))
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/', secure: process.env.NODE_ENV === 'production', maxAge: 14 * 86400 })
    return c.redirect('/')
  })

  app.get('/logout', async (c) => {
    const token = getCookie(c, COOKIE)
    if (token) await logout(db, token)
    deleteCookie(c, COOKIE, { path: '/' })
    return c.redirect('/login')
  })

  // Everything below needs a session (cookie for screens, bearer token for the API).
  app.use('*', async (c, next) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1]
    const token = bearer ?? getCookie(c, COOKIE)
    const user = token ? await sessionUser(db, token) : null
    if (!user) return c.req.path.startsWith('/api/') ? c.json({ error: 'not logged in' }, 401) : c.redirect('/login')
    c.set('user', user)
    await next()
  })

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      if (c.req.path.startsWith('/api/')) return c.json({ error: err.message, code: err.code }, err.status as any)
      const ref = c.req.header('referer')
      const path = ref ? new URL(ref).pathname + new URL(ref).search.replace(/[?&](ok|err)=[^&]*/g, '') : '/'
      return back(c as Ctx, path || '/', { err: err.message })
    }
    console.error(err)
    return c.text('Something went wrong. The error has been logged.', 500)
  })

  app.get('/', async (c) => {
    const { counts, value, negative } = await run(c, async (tx) => ({
      counts: await reports.counts(tx),
      value: await reports.stockValuation(tx),
      negative: (await reports.negativeStock(tx)).length,
    }))
    return page(c, 'Home', (
      <>
        <h1>{c.get('user').tenantName}</h1>
        <form action="/items" class="row panel">
          <input name="q" data-search placeholder="Scan a barcode or type an item name  ( / )" style="flex:1" autofocus />
          <button>Find</button>
        </form>
        <div class="stats">
          <a class="stat" href="/items"><b>{counts.active.toLocaleString()}</b><span>active items</span></a>
          <a class="stat" href="/items?status=dormant"><b>{counts.dormant.toLocaleString()}</b><span>dormant (catalogue only)</span></a>
          <a class="stat" href="/reports/quarantine"><b>{counts.quarantined.toLocaleString()}</b><span>quarantined, need fixing</span></a>
          <a class="stat" href="/reports/negative"><b>{negative}</b><span>items with negative stock</span></a>
          <a class="stat" href="/reports/valuation"><b>{money(value.costValue)}</b><span>stock at cost</span></a>
          <a class="stat" href="/reports/valuation"><b>{money(value.retailValue)}</b><span>stock at retail</span></a>
        </div>
      </>
    ))
  })

  app.route('/items', itemRoutes())
  app.route('/receiving', receivingRoutes())
  app.route('/stocktakes', stockTakeRoutes())
  app.route('/reports', reportRoutes())
  app.route('/settings', settingsRoutes())
  app.route('/cashup', cashupRoutes())
  app.route('/sales', salesRoutes())
  app.route('/accounts', accountRoutes())
  app.route('/dispensary', dispensaryRoutes())
  app.route('/', tillRoutes())
  app.route('/api', api())

  return app
}

export { num }
