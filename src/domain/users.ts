import type { Tx } from '../db/index.js'
import { can, isRole, type Permission, type Role } from '../security/roles.js'
import { endSessions, hashPassword, passwordProblem, verifyPassword } from './auth.js'
import { DomainError } from './errors.js'
import { audit } from './items.js'

/** Logins for one pharmacy. Only managers reach these (see src/security/routes.ts). */

export interface UserRow {
  id: string
  email: string
  name: string
  staffCode: string | null
  roles: Role[]
  active: boolean
  secondFactor: boolean
  lockedUntil: Date | null
  createdAt: Date
}

const row = (u: any): UserRow => ({
  id: u.id, email: u.email, name: u.name, staffCode: u.staff_code ?? null, roles: (u.roles as string[]).filter(isRole), active: u.active,
  secondFactor: !!u.second_pin_hash, lockedUntil: u.locked_until && new Date(u.locked_until) > new Date() ? u.locked_until : null, createdAt: u.created_at,
})

export async function listUsers(tx: Tx): Promise<UserRow[]> {
  return (await tx`select * from users order by active desc, name`).map(row)
}

export async function getUser(tx: Tx, id: string): Promise<UserRow | null> {
  const [u] = await tx`select * from users where id = ${id}`
  return u ? row(u) : null
}

function cleanRoles(input: unknown[]): Role[] {
  const out = [...new Set(input.filter(isRole))]
  if (!out.length) throw new DomainError('give the login at least one role')
  return out
}

function cleanEmail(email: string) {
  const e = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new DomainError('enter a valid email address')
  return e
}

/** A 2-letter staff code, upper case; blank means none. */
export function cleanStaffCode(code: unknown): string | null {
  const c = String(code ?? '').trim().toUpperCase()
  if (!c) return null
  if (!/^[A-Z]{2}$/.test(c)) throw new DomainError('a staff code is exactly two letters, like JM')
  return c
}

async function checkCodeFree(tx: Tx, code: string | null, exceptId?: string) {
  if (!code) return
  const [t] = await tx`select name from users where staff_code = ${code} and id <> ${exceptId ?? '00000000-0000-0000-0000-000000000000'}`
  if (t) throw new DomainError(`the code ${code} already belongs to ${t.name}`)
}

export async function createUser(tx: Tx, input: { email: string; name: string; roles: unknown[]; password: string; staffCode?: string | null }, by: string): Promise<string> {
  const email = cleanEmail(input.email)
  const name = input.name.trim()
  if (!name) throw new DomainError('enter the person\'s name')
  const roles = cleanRoles(input.roles)
  const staffCode = cleanStaffCode(input.staffCode)
  await checkCodeFree(tx, staffCode)
  const problem = passwordProblem(input.password, email)
  if (problem) throw new DomainError(problem)
  const [taken] = await tx`select 1 from auth_lookup(${email})`
  if (taken) throw new DomainError('that email address already has a login')
  const [u] = await tx`
    insert into users (tenant_id, email, name, roles, password_hash, staff_code)
    values (current_setting('app.tenant_id')::uuid, ${email}, ${name}, ${roles}, ${await hashPassword(input.password)}, ${staffCode}) returning id`
  await audit(tx, by, 'create', 'user', u.id, { after: { email, name, roles, staffCode } })
  return u.id
}

/**
 * The active login behind a 2-letter code, if the code is theirs and their roles let them do the job
 * (e.g. 'till.use' for a cashier code, 'rx.capture' for a dispenser code).
 */
export async function staffByCode(tx: Tx, code: unknown, perm: Permission): Promise<{ id: string; name: string; code: string } | null> {
  const c = String(code ?? '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(c)) return null
  const [u] = await tx`select id, name, roles from users where staff_code = ${c} and active`
  if (!u || !can((u.roles as string[]).filter(isRole), perm)) return null
  return { id: u.id as string, name: u.name as string, code: c }
}

/** Everyone with a code who may do the job, for the till to check codes against while offline. */
export async function staffWithCodes(tx: Tx, perm: Permission): Promise<{ code: string; name: string }[]> {
  const rows = await tx`select name, staff_code, roles from users where active and staff_code is not null order by staff_code`
  return rows.filter((u) => can((u.roles as string[]).filter(isRole), perm)).map((u) => ({ code: u.staff_code as string, name: u.name as string }))
}

/** Change name, email, roles or active. A manager can't take away their own manager role or switch themselves off. */
export async function updateUser(tx: Tx, id: string, input: { name: string; email: string; roles: unknown[]; active: boolean; staffCode?: string | null }, by: string) {
  const before = await getUser(tx, id)
  if (!before) throw new DomainError('unknown user', 'not_found', 404)
  // Callers that don't send a code leave it as it is.
  const staffCode = input.staffCode === undefined ? before.staffCode : cleanStaffCode(input.staffCode)
  await checkCodeFree(tx, staffCode, id)
  const roles = cleanRoles(input.roles)
  const email = cleanEmail(input.email)
  const name = input.name.trim()
  if (!name) throw new DomainError('enter the person\'s name')
  if (id === by && (!roles.includes('manager') || !input.active)) {
    throw new DomainError('you cannot remove your own manager role or switch off your own login; ask another manager')
  }
  if (email !== before.email) {
    const [taken] = await tx`select 1 from auth_lookup(${email})`
    if (taken) throw new DomainError('that email address already has a login')
  }
  await tx`update users set name = ${name}, email = ${email}, roles = ${roles}, active = ${input.active}, staff_code = ${staffCode} where id = ${id}`
  const [m] = await tx`select count(*)::int as n from users where active and 'manager' = any(roles)`
  if (m.n < 1) throw new DomainError('the pharmacy must keep at least one active manager')
  const changedAccess = before.active !== input.active || before.roles.join() !== roles.join() || before.email !== email
  if (changedAccess) await endSessions(tx, id)
  await audit(tx, by, 'update', 'user', id, {
    before: { name: before.name, email: before.email, roles: before.roles, active: before.active, staffCode: before.staffCode },
    after: { name, email, roles, active: input.active, staffCode },
  })
}

/** A manager sets a new password for someone (e.g. they forgot it). Their sessions end. */
export async function setPassword(tx: Tx, id: string, password: string, by: string | null) {
  const u = await getUser(tx, id)
  if (!u) throw new DomainError('unknown user', 'not_found', 404)
  const problem = passwordProblem(password, u.email)
  if (problem) throw new DomainError(problem)
  await tx`update users set password_hash = ${await hashPassword(password)}, password_changed_at = now() where id = ${id}`
  await endSessions(tx, id)
  await audit(tx, by, 'set_password', 'user', id)
}

/** Change your own password; needs the current one. Other sessions end; the caller logs in again. */
export async function changeOwnPassword(tx: Tx, id: string, current: string, next: string) {
  const [u] = await tx`select email, password_hash from users where id = ${id}`
  if (!u || !(await verifyPassword(current, u.password_hash))) throw new DomainError('your current password is wrong')
  const problem = passwordProblem(next, u.email)
  if (problem) throw new DomainError(problem)
  await tx`update users set password_hash = ${await hashPassword(next)}, password_changed_at = now() where id = ${id}`
  await endSessions(tx, id)
  await audit(tx, id, 'change_password', 'user', id)
}

export async function unlockUser(tx: Tx, id: string, by: string | null) {
  await tx`update users set failed_logins = 0, locked_until = null where id = ${id}`
  await audit(tx, by, 'unlock', 'user', id)
}

/** Clear someone's second PIN (forgotten). They choose a new one at their next login. */
export async function resetSecondFactor(tx: Tx, id: string, by: string | null) {
  await tx`update users set second_pin_hash = null where id = ${id}`
  await endSessions(tx, id)
  await audit(tx, by, 'reset_second_factor', 'user', id)
}
