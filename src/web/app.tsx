import { Hono, type Context } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Sql, Tx } from '../db/index.js'
import { num, withTenant } from '../db/index.js'
import { sessionFor, type SessionUser } from '../domain/auth.js'
import { DomainError } from '../domain/errors.js'
import { security } from '../security/config.js'
import { RateLimiter } from '../security/ratelimit.js'
import { can as roleCan, type Permission } from '../security/roles.js'
import { guard } from '../security/routes.js'
import { SESSION_COOKIE, loginRoutes } from './login.js'
import { meRoutes, userRoutes } from './users.js'
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

export type Env = { Variables: { user: SessionUser; db: Sql; pending: boolean; loginLimiter: RateLimiter } }
export type Ctx = Context<Env>

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

/** Whether the logged-in user holds a permission; for deciding what a screen shows. The route guard does the enforcing. */
export function can(c: Ctx, perm: Permission): boolean {
  return roleCan(c.get('user').roles, perm)
}

/** Refuse unless the user holds perm: for checks inside a route that depend on what was posted. */
export function requirePermission(c: Ctx, perm: Permission, why = 'You do not have permission to do that.') {
  if (!can(c, perm)) throw new DomainError(why, 'forbidden', 403)
}

/**
 * The caller's address, for the audit log and login rate limits. X-Forwarded-For is only
 * believed when TRUST_PROXY is set (the app sits behind Caddy), otherwise anyone could fake it.
 */
export function clientIp(c: Context): string | null {
  if (process.env.TRUST_PROXY) {
    const fwd = c.req.header('x-forwarded-for')?.split(',').pop()?.trim()
    if (fwd) return fwd
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  return env?.incoming?.socket?.remoteAddress ?? null
}

export function page(c: Ctx, title: string, body: any) {
  return c.html(<Layout title={title} user={c.get('user')} path={c.req.path} flash={flash(c)}>{body}</Layout>)
}

export function createApp(db: Sql) {
  const app = new Hono<Env>()

  const loginLimiter = new RateLimiter(security.ipAttempts, security.ipWindowMinutes * 60_000)
  app.use('*', async (c, next) => { c.set('db', db); c.set('loginLimiter', loginLimiter); await next() })

  // Read the session, if any (cookie for screens, bearer token for the API). A till's
  // background polling sends x-sylken-background so it doesn't keep an idle session alive.
  app.use('*', async (c, next) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1]
    const token = bearer ?? getCookie(c, SESSION_COOKIE)
    const s = token ? await sessionFor(db, token, { touch: c.req.header('x-sylken-background') !== '1' }) : null
    if (s) { c.set('user', s.user); c.set('pending', s.pending) }
    await next()
  })

  // Every route's permission is checked here, from src/security/routes.ts. Unlisted routes are refused.
  app.use('*', guard({
    principal: (c) => {
      const user = c.get('user') as SessionUser | undefined
      return user ? { roles: user.roles, pending: !!c.get('pending') } : null
    },
    onDenied: (c, why) => {
      const api = c.req.path.startsWith('/api/')
      if (why === 'login') {
        if (api) return c.json({ error: 'not logged in' }, 401)
        return c.redirect(c.get('pending') ? '/login/2fa' : '/login')
      }
      if (api) return c.json({ error: 'forbidden' }, 403)
      return c.html(<Layout title="Not allowed" user={c.get('user')} path={c.req.path}>
        <h1>Not allowed</h1><p>Your login does not allow this. Ask a manager if you need it.</p><p><a href="/">Home</a></p></Layout>, 403)
    },
  }))

  app.get('/health', (c) => c.text('ok'))
  app.route('/', loginRoutes())

  app.onError((err, c) => {
    if (err instanceof DomainError && err.status === 401) {
      return c.req.path.startsWith('/api/') ? c.json({ error: err.message }, 401) : c.redirect('/login?err=' + encodeURIComponent(err.message))
    }
    if (err instanceof DomainError && err.status === 403 && !c.req.path.startsWith('/api/')) {
      return c.html(<Layout title="Not allowed" user={c.get('user')} path={c.req.path}>
        <h1>Not allowed</h1><p>{err.message}</p><p><a href="/">Home</a></p></Layout>, 403)
    }
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
  app.route('/users', userRoutes())
  app.route('/me', meRoutes())

  return app
}

export { num }
