/**
 * Who may do what. This file is the single source of truth for permissions: routes name a
 * permission in ./routes.ts, and screens ask can() only to decide what to show. A person can
 * hold several roles (an owner-pharmacist is pharmacist + manager) and gets every permission
 * any of them grants. Anything not granted here is refused.
 */

export const roles = ['assistant', 'supervisor', 'dispenser', 'pharmacist', 'manager'] as const
export type Role = (typeof roles)[number]

/** "assistant" is the stored name of the cashier role. */
export const roleLabels: Record<Role, string> = {
  assistant: 'Cashier',
  supervisor: 'Supervisor',
  dispenser: 'Dispenser',
  pharmacist: 'Pharmacist',
  manager: 'Manager',
}

/** Roles that must use a second PIN at every login. */
export const secondFactorRoles: readonly Role[] = ['supervisor', 'pharmacist', 'manager']

export const permissions = {
  'home.view': 'See the home page',
  'items.view': 'Look up items, prices and stock on hand',
  'items.edit': 'Add items and change their details and prices',
  'stock.receive': 'Book in supplier deliveries',
  'stock.adjust': 'Stock takes, stock adjustments and min/max levels',
  'stock.reports': 'Stock and sales reports',
  'till.use': 'Ring up sales and take payment for scripts at the till',
  'till.approve': 'Approve discounts, price changes and refunds at the till with a staff code and second PIN',
  'cashup.own': 'Cash up a till run blind',
  'cashup.manage': 'See expected cash, manage tills and till problems',
  'accounts.view': 'See customer accounts',
  'accounts.manage': 'Open accounts and post account adjustments',
  'sales.view': 'Sales journal and till reports',
  'rx.view': 'Open patients, scripts, allergies, clinical notes and the register',
  'rx.capture': 'Add patients, doctors and allergies, and capture scripts',
  'rx.dispense': 'Dispense a script with no clinical or stock warnings to override',
  'rx.override': 'Override a clinical or stock warning when dispensing or supplying',
  'rx.check': 'Check a script someone else dispensed',
  'rx.reverse': 'Reverse a dispensed script (return) and cancel owed items',
  'rx.flags.remove': 'Remove an allergy or alert from a patient',
  'rx.reports': 'Dispensary reports with no patient names (drug usage, script totals)',
  'rx.settings': 'Dispensary settings, medical aids and label directions',
  'rx.claims': 'Make and download medical aid claim files',
  'settings.manage': 'Shop settings and quick buttons',
  'users.manage': 'Add users, set roles, unlock and reset logins',
  'audit.view': 'Read the audit log',
  'self.manage': 'Change your own password and second factor',
} as const
export type Permission = keyof typeof permissions

const everyone: Permission[] = ['home.view', 'items.view', 'till.use', 'cashup.own', 'accounts.view', 'self.manage']

export const rolePermissions: Record<Role, readonly Permission[]> = {
  assistant: everyone,
  supervisor: [...everyone, 'items.edit', 'stock.receive', 'stock.adjust', 'stock.reports', 'cashup.manage', 'sales.view', 'till.approve'],
  dispenser: [...everyone, 'stock.receive', 'rx.view', 'rx.capture', 'rx.dispense'],
  pharmacist: [...everyone, 'items.edit', 'stock.receive', 'stock.reports', 'accounts.manage', 'sales.view',
    'rx.view', 'rx.capture', 'rx.dispense', 'rx.override', 'rx.check', 'rx.reverse', 'rx.flags.remove', 'rx.reports', 'rx.settings', 'rx.claims'],
  manager: [...everyone, 'items.edit', 'stock.receive', 'stock.adjust', 'stock.reports', 'cashup.manage', 'accounts.manage',
    'sales.view', 'rx.reports', 'rx.settings', 'settings.manage', 'users.manage', 'audit.view', 'till.approve'],
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (roles as readonly string[]).includes(v)
}

export function can(userRoles: readonly Role[], perm: Permission): boolean {
  return userRoles.some((r) => rolePermissions[r]?.includes(perm))
}

export function needsSecondFactor(userRoles: readonly Role[]): boolean {
  return userRoles.some((r) => secondFactorRoles.includes(r))
}
