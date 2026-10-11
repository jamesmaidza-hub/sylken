import type { Context, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import type { Permission, Role } from './roles.js'
import { can } from './roles.js'

/**
 * The permission every route needs, checked on the server before the route runs.
 *
 * Deny by default: a request whose method and path are not listed here is refused with 403,
 * even when a handler exists for it. test/security/access.test.ts fails if a route is added to
 * the app without a line here, or a line here no longer matches a route.
 *
 * 'public'  needs no session (login page, health check).
 * 'pending' needs only a password-checked session that is still waiting for its second factor.
 */
export type Rule = Permission | 'public' | 'pending'

export const routePermissions: [method: 'GET' | 'POST', path: string, rule: Rule][] = [
  ['GET', '/health', 'public'],
  ['GET', '/login', 'public'],
  ['POST', '/login', 'public'],
  ['GET', '/logout', 'public'],
  ['GET', '/login/2fa', 'pending'],
  ['POST', '/login/2fa', 'pending'],
  ['GET', '/login/2fa/setup', 'pending'],
  ['POST', '/login/2fa/setup', 'pending'],

  ['GET', '/', 'home.view'],

  // Your own login
  ['GET', '/me', 'self.manage'],
  ['POST', '/me/password', 'self.manage'],

  // Users (managers only)
  ['GET', '/users', 'users.manage'],
  ['POST', '/users', 'users.manage'],
  ['GET', '/users/:id', 'users.manage'],
  ['POST', '/users/:id', 'users.manage'],
  ['POST', '/users/:id/password', 'users.manage'],
  ['POST', '/users/:id/unlock', 'users.manage'],
  ['POST', '/users/:id/reset-2fa', 'users.manage'],

  // Items and stock
  ['GET', '/items', 'items.view'],
  ['GET', '/items/new', 'items.edit'],
  ['POST', '/items', 'items.edit'],
  ['GET', '/items/:id', 'items.view'],
  ['POST', '/items/:id', 'items.edit'],
  ['POST', '/items/:id/adjust', 'stock.adjust'],
  ['POST', '/items/:id/minmax', 'stock.adjust'],
  ['GET', '/receiving', 'stock.receive'],
  ['POST', '/receiving', 'stock.receive'],
  ['GET', '/receiving/:id', 'stock.receive'],
  ['POST', '/receiving/:id/lines', 'stock.receive'],
  ['POST', '/receiving/:id/lines/:line/delete', 'stock.receive'],
  ['POST', '/receiving/:id/post', 'stock.receive'],
  ['GET', '/stocktakes', 'stock.adjust'],
  ['POST', '/stocktakes', 'stock.adjust'],
  ['GET', '/stocktakes/:id', 'stock.adjust'],
  ['POST', '/stocktakes/:id/count', 'stock.adjust'],
  ['POST', '/stocktakes/:id/post', 'stock.adjust'],
  ['POST', '/stocktakes/:id/cancel', 'stock.adjust'],

  // Stock and sales reports
  ['GET', '/reports', 'stock.reports'],
  ['GET', '/reports/minmax', 'stock.reports'],
  ['GET', '/reports/minmax/suggest', 'stock.adjust'],
  ['POST', '/reports/minmax/apply', 'stock.adjust'],
  ['GET', '/reports/valuation', 'stock.reports'],
  ['GET', '/reports/negative', 'stock.reports'],
  ['GET', '/reports/dormant', 'stock.reports'],
  ['GET', '/reports/adjustments', 'stock.reports'],
  ['GET', '/reports/gp', 'stock.reports'],
  ['GET', '/reports/quarantine', 'stock.reports'],
  ['GET', '/reports/sales', 'sales.view'],
  ['GET', '/reports/sales-gp', 'sales.view'],

  // Dispensary reports: totals only need rx.reports; anything naming patients needs rx.view
  ['GET', '/reports/rx', 'rx.reports'],
  ['GET', '/reports/rx/drug-usage', 'rx.reports'],
  ['GET', '/reports/rx/scripts', 'rx.reports'],
  ['GET', '/reports/rx/price-changes', 'rx.reports'],
  ['GET', '/reports/rx/patients', 'rx.view'],
  ['GET', '/reports/rx/last-visit', 'rx.view'],
  ['GET', '/reports/rx/repeats', 'rx.view'],
  ['GET', '/reports/rx/reversed', 'rx.view'],

  // Till and account reports
  ['GET', '/reports/till/statements', 'sales.view'],
  ['GET', '/reports/till/debtors', 'sales.view'],
  ['GET', '/reports/till/account-transactions', 'sales.view'],
  ['GET', '/reports/till/journal', 'sales.view'],
  ['GET', '/reports/till/detail', 'sales.view'],
  ['GET', '/reports/till/assistants', 'sales.view'],
  ['GET', '/reports/till/petty-cash', 'sales.view'],
  ['GET', '/reports/till/price-alterations', 'sales.view'],
  ['GET', '/reports/till/otc', 'sales.view'],
  ['GET', '/reports/till/markup', 'sales.view'],
  ['GET', '/reports/till/contacts', 'sales.view'],
  ['GET', '/reports/till/audit', 'audit.view'],

  // Shop settings
  ['GET', '/settings', 'settings.manage'],
  ['POST', '/settings', 'settings.manage'],
  ['POST', '/settings/till-buttons', 'settings.manage'],
  ['POST', '/settings/rx-buttons', 'settings.manage'],
  ['POST', '/settings/reprice', 'settings.manage'],

  // Till, cash-up, sales, accounts
  ['GET', '/till', 'till.use'],
  ['GET', '/till/', 'till.use'],
  ['GET', '/till/app.js', 'till.use'],
  ['GET', '/till/sw.js', 'till.use'],
  ['GET', '/cashup', 'cashup.own'],
  ['POST', '/cashup/tills', 'cashup.manage'],
  ['GET', '/cashup/runs/:id', 'cashup.own'],
  ['POST', '/cashup/runs/:id/close', 'cashup.own'],
  ['GET', '/cashup/problems', 'cashup.manage'],
  ['POST', '/cashup/problems/:id/resolve', 'cashup.manage'],
  ['GET', '/sales', 'sales.view'],
  ['GET', '/sales/:id', 'sales.view'],
  ['GET', '/sales/:id/slip', 'sales.view'],
  ['GET', '/accounts', 'accounts.view'],
  ['POST', '/accounts', 'accounts.manage'],
  ['GET', '/accounts/aging', 'accounts.view'],
  ['GET', '/accounts/:id', 'accounts.view'],
  ['POST', '/accounts/:id/entries', 'accounts.manage'],

  // Dispensary
  ['GET', '/dispensary', 'rx.view'],
  ['GET', '/dispensary/patients/new', 'rx.capture'],
  ['POST', '/dispensary/patients', 'rx.capture'],
  ['GET', '/dispensary/patients/:id', 'rx.view'],
  ['POST', '/dispensary/patients/:id', 'rx.capture'],
  ['POST', '/dispensary/patients/:id/flags', 'rx.capture'],
  ['POST', '/dispensary/flags/:id/remove', 'rx.flags.remove'],
  ['POST', '/dispensary/patients/:id/scripts', 'rx.capture'],
  ['GET', '/dispensary/scripts', 'rx.view'],
  ['GET', '/dispensary/scripts/:id', 'rx.view'],
  ['POST', '/dispensary/scripts/:id', 'rx.capture'],
  ['POST', '/dispensary/scripts/:id/lines', 'rx.capture'],
  ['POST', '/dispensary/scripts/:id/lines/:line/delete', 'rx.capture'],
  ['POST', '/dispensary/scripts/:id/lines/:line/supply', 'rx.capture'],
  ['POST', '/dispensary/scripts/:id/dispense', 'rx.dispense'],   // overrides also need rx.override (checked in the route)
  ['POST', '/dispensary/scripts/:id/check', 'rx.check'],
  ['POST', '/dispensary/scripts/:id/discard', 'rx.capture'],
  ['POST', '/dispensary/scripts/:id/reverse', 'rx.reverse'],
  ['POST', '/dispensary/scripts/:id/repeat', 'rx.capture'],
  ['GET', '/dispensary/scripts/:id/labels', 'rx.view'],
  ['GET', '/dispensary/supplies/:id/label', 'rx.view'],
  ['GET', '/dispensary/owed', 'rx.view'],
  ['POST', '/dispensary/owed/:id/supply', 'rx.dispense'],        // the stock override also needs rx.override
  ['POST', '/dispensary/owed/:id/cancel', 'rx.reverse'],
  ['GET', '/dispensary/register', 'rx.view'],
  ['GET', '/dispensary/doctors', 'rx.view'],
  ['POST', '/dispensary/doctors', 'rx.capture'],
  ['GET', '/dispensary/doctors/:id', 'rx.view'],
  ['POST', '/dispensary/doctors/:id', 'rx.capture'],
  ['GET', '/dispensary/settings', 'rx.settings'],
  ['POST', '/dispensary/settings', 'rx.settings'],
  ['POST', '/dispensary/settings/aids', 'rx.settings'],
  ['POST', '/dispensary/settings/aids/:id', 'rx.settings'],
  ['POST', '/dispensary/settings/directions', 'rx.settings'],

  // JSON API
  ['GET', '/api/items/lookup', 'items.view'],
  ['GET', '/api/items', 'items.view'],
  ['POST', '/api/movements', 'stock.adjust'],
  ['GET', '/api/till/catalogue', 'till.use'],
  ['GET', '/api/till/scripts/:no', 'till.use'],
  ['POST', '/api/till/sync', 'till.use'],
]

const table = new Map(routePermissions.map(([method, path, rule]) => [`${method} ${path}`, rule]))

/**
 * The rule for the route that will answer this request, found from the route the router
 * actually matched (not by re-parsing the URL), or null when it is not listed.
 */
export function ruleFor(c: Context): Rule | null {
  const handler = matchedRoutes(c).find((r) => r.method !== 'ALL')
  if (!handler) return null
  const method = c.req.method === 'HEAD' ? 'GET' : c.req.method
  return table.get(`${method} ${handler.path}`) ?? null
}

export interface Principal { roles: readonly Role[]; pending: boolean }

/**
 * Refuse any request the caller's roles don't allow. Runs after the session is read, so
 * c.get('principal') is null for nobody logged in.
 */
export function guard(opts: { principal: (c: Context) => Principal | null; onDenied: (c: Context, why: 'login' | 'forbidden') => Response | Promise<Response> }): MiddlewareHandler {
  return async (c, next) => {
    const rule = ruleFor(c)
    if (rule === 'public') return next()
    const who = opts.principal(c)
    if (!who) return opts.onDenied(c, 'login')
    if (rule === 'pending') return who.pending ? next() : c.redirect('/')
    if (who.pending) return opts.onDenied(c, 'login')
    if (rule === null || !can(who.roles, rule)) return opts.onDenied(c, 'forbidden')
    return next()
  }
}
