import type { Tx } from '../db/index.js'
import { isRole, type Role } from '../security/roles.js'
import { endSessions, hashPassword, passwordProblem, verifyPassword } from './auth.js'
import { DomainError } from './errors.js'
import { audit } from './items.js'

/** Logins for one pharmacy. Only managers reach these (see src/security/routes.ts). */

export interface UserRow {
  id: string
  email: string
  name: string
  roles: Role[]
  active: boolean
  secondFactor: boolean
  lockedUntil: Date | null
  createdAt: Date
}

const row = (u: any): UserRow => ({
  id: u.id, email: u.email, name: u.name, roles: (u.roles as string[]).filter(isRole), active: u.active,
  secondFactor: !!u.totp_enabled_at, lockedUntil: u.locked_until && new Date(u.locked_until) > new Date() ? u.locked_until : null, createdAt: u.created_at,
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

export async function createUser(tx: Tx, input: { email: string; name: string; roles: unknown[]; password: string }, by: string): Promise<string> {
  const email = cleanEmail(input.email)
  const name = input.name.trim()
  if (!name) throw new DomainError('enter the person\'s name')
  const roles = cleanRoles(input.roles)
  const problem = passwordProblem(input.password, email)
  if (problem) throw new DomainError(problem)
  const [taken] = await tx`select 1 from auth_lookup(${email})`
  if (taken) throw new DomainError('that email address already has a login')
  const [u] = await tx`
    insert into users (tenant_id, email, name, roles, password_hash)
    values (current_setting('app.tenant_id')::uuid, ${email}, ${name}, ${roles}, ${await hashPassword(input.password)}) returning id`
  await audit(tx, by, 'create', 'user', u.id, { after: { email, name, roles } })
  return u.id
}

/** Change name, email, roles or active. A manager can't take away their own manager role or switch themselves off. */
export async function updateUser(tx: Tx, id: string, input: { name: string; email: string; roles: unknown[]; active: boolean }, by: string) {
  const before = await getUser(tx, id)
  if (!before) throw new DomainError('unknown user', 'not_found', 404)
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
  await tx`update users set name = ${name}, email = ${email}, roles = ${roles}, active = ${input.active} where id = ${id}`
  const [m] = await tx`select count(*)::int as n from users where active and 'manager' = any(roles)`
  if (m.n < 1) throw new DomainError('the pharmacy must keep at least one active manager')
  const changedAccess = before.active !== input.active || before.roles.join() !== roles.join() || before.email !== email
  if (changedAccess) await endSessions(tx, id)
  await audit(tx, by, 'update', 'user', id, {
    before: { name: before.name, email: before.email, roles: before.roles, active: before.active },
    after: { name, email, roles, active: input.active },
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

/** Clear someone's authenticator (lost phone). They set up a new one at their next login. */
export async function resetSecondFactor(tx: Tx, id: string, by: string | null) {
  await tx`update users set totp_secret = null, totp_enabled_at = null, totp_last_step = null where id = ${id}`
  await tx`delete from recovery_codes where user_id = ${id}`
  await endSessions(tx, id)
  await audit(tx, by, 'reset_second_factor', 'user', id)
}
