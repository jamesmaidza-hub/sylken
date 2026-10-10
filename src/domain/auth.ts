import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Sql, Tx } from '../db/index.js'
import { withTenant } from '../db/index.js'
import { security } from '../security/config.js'
import { open, seal, tokenHash } from '../security/crypto.js'
import { isRole, needsSecondFactor, type Role } from '../security/roles.js'
import { newSecret, verifyCode } from '../security/totp.js'
import { DomainError } from './errors.js'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, 32)
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, salt, key] = stored.split('$')
  if (alg !== 'scrypt' || !salt || !key) return false
  const expected = Buffer.from(key, 'base64')
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length)
  return timingSafeEqual(expected, actual)
}

// Checked against when the email is unknown, so a wrong email takes as long as a wrong password.
const dummyHash = hashPassword(randomBytes(16).toString('hex'))

/** Why a password is not acceptable, or null. */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < security.minPasswordLength) return `use at least ${security.minPasswordLength} characters`
  if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) return 'the password cannot be the email address'
  return null
}

export interface SessionUser {
  userId: string
  tenantId: string
  name: string
  email: string
  roles: Role[]
  tenantName: string
}

/** Where a request came from, kept with sessions and in the audit log. */
export interface ClientMeta { ip?: string | null; userAgent?: string | null }

export type LoginResult =
  | { ok: false }
  | { ok: true; token: string; next: 'done' | 'second_factor' | 'set_up_second_factor' }

/** The one message for every failed login, so it never says whether the email exists or is locked. */
export const loginFailedMessage = `Wrong email or password. After ${security.maxFailures} wrong tries in a row the login locks for ${security.lockMinutes} minutes.`

/**
 * Check an email and password. People whose roles need a second factor get a short session
 * that only reaches the second-factor pages; everyone else gets a full session.
 */
export async function login(db: Sql, email: string, password: string, meta: ClientMeta = {}): Promise<LoginResult> {
  const [u] = await db`select * from auth_lookup(${email.trim()})`
  if (!u) {
    await verifyPassword(password, await dummyHash)
    return { ok: false }
  }
  const locked = u.locked_until && new Date(u.locked_until) > new Date()
  const good = await verifyPassword(password, u.password_hash)
  if (locked) {
    await logAuth(db, u.tenant_id, u.user_id, 'login_refused_locked', meta)
    return { ok: false }
  }
  if (!good || !u.active) {
    await recordFailure(db, u.tenant_id, u.user_id, good ? 'login_refused_inactive' : 'login_failed', meta)
    return { ok: false }
  }
  const roles = (u.roles as string[]).filter(isRole)
  const pending = needsSecondFactor(roles)
  await withTenant(db, u.tenant_id, async (tx) => {
    if (!pending) await tx`update users set failed_logins = 0, locked_until = null where id = ${u.user_id}`
    await auditAuth(tx, u.user_id, pending ? 'password_ok' : 'login', meta)
  })
  const token = await createSession(db, u.user_id, u.tenant_id, pending, meta)
  return { ok: true, token, next: !pending ? 'done' : u.totp_enabled ? 'second_factor' : 'set_up_second_factor' }
}

async function createSession(db: Sql, userId: string, tenantId: string, pending: boolean, meta: ClientMeta): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const life = pending ? `${security.pendingMinutes} minutes` : `${security.absoluteHours} hours`
  await db`insert into sessions (token_hash, user_id, tenant_id, mfa_pending, expires_at, ip, user_agent)
           values (${tokenHash(token)}, ${userId}, ${tenantId}, ${pending}, now() + ${life}::interval,
                   ${meta.ip ?? null}, ${meta.userAgent?.slice(0, 200) ?? null})`
  return token
}

/** Count a wrong password or code; lock the account when there have been too many in a row. */
async function recordFailure(db: Sql, tenantId: string, userId: string, action: string, meta: ClientMeta) {
  await withTenant(db, tenantId, async (tx) => {
    const [r] = await tx`
      update users set failed_logins = failed_logins + 1,
             locked_until = case when failed_logins + 1 >= ${security.maxFailures}
                                 then now() + ${security.lockMinutes + ' minutes'}::interval else locked_until end
       where id = ${userId} returning failed_logins, locked_until`
    await auditAuth(tx, userId, action, meta)
    if (r && r.failed_logins >= security.maxFailures) {
      await tx`update users set failed_logins = 0 where id = ${userId}`
      await auditAuth(tx, userId, 'locked', meta, { minutes: security.lockMinutes })
    }
  })
}

async function logAuth(db: Sql, tenantId: string, userId: string, action: string, meta: ClientMeta) {
  await withTenant(db, tenantId, (tx) => auditAuth(tx, userId, action, meta))
}

export async function auditAuth(tx: Tx, userId: string, action: string, meta: ClientMeta, extra: Record<string, unknown> = {}) {
  await tx`insert into audit_log (tenant_id, user_id, action, entity, entity_id, detail)
           values (current_setting('app.tenant_id')::uuid, ${userId}, ${action}, 'login', ${userId},
                   ${tx.json({ ip: meta.ip ?? null, ...extra } as any)})`
}

export interface SessionInfo { user: SessionUser; pending: boolean }

/**
 * The session for a token, or null when there is none or it has run out (idle or absolute
 * limit). touch: count this request as activity, which keeps an idle session alive.
 */
export async function sessionFor(db: Sql, token: string, opts: { touch?: boolean } = {}): Promise<SessionInfo | null> {
  const hash = tokenHash(token)
  const [s] = await db`
    select user_id, tenant_id, mfa_pending from sessions
     where token_hash = ${hash} and expires_at > now()
       and last_seen_at > now() - ${security.idleMinutes + ' minutes'}::interval`
  if (!s) {
    await db`delete from sessions where token_hash = ${hash}`
    return null
  }
  const user = await withTenant(db, s.tenant_id, async (tx) => {
    const [u] = await tx`select u.name, u.email, u.roles, u.active, t.name as tenant_name
                           from users u join tenants t on t.id = u.tenant_id where u.id = ${s.user_id}`
    if (!u || !u.active) return null
    return { userId: s.user_id, tenantId: s.tenant_id, name: u.name, email: u.email, roles: (u.roles as string[]).filter(isRole), tenantName: u.tenant_name } as SessionUser
  })
  if (!user || !user.roles.length) {
    await db`delete from sessions where token_hash = ${hash}`
    return null
  }
  if (opts.touch) await db`update sessions set last_seen_at = now() where token_hash = ${hash}`
  return { user, pending: s.mfa_pending }
}

/** Kept for callers that only need the user of a full (not pending) session. */
export async function sessionUser(db: Sql, token: string): Promise<SessionUser | null> {
  const s = await sessionFor(db, token)
  return s && !s.pending ? s.user : null
}

export async function logout(db: Sql, token: string) {
  await db`delete from sessions where token_hash = ${tokenHash(token)}`
}

export async function endSessions(tx: Tx | Sql, userId: string) {
  await tx`delete from sessions where user_id = ${userId}`
}

// ---------------------------------------------------------------- second factor

async function pendingSession(db: Sql, token: string) {
  const s = await sessionFor(db, token)
  if (!s || !s.pending) throw new DomainError('Your login has expired. Log in again.', 'expired', 401)
  const [lock] = await withTenant(db, s.user.tenantId, (tx) => tx`select 1 from users where id = ${s.user.userId} and locked_until > now()`)
  if (lock) {
    await logout(db, token)
    throw new DomainError(loginFailedMessage, 'locked', 401)
  }
  return s.user
}

/** Turn a pending session into a full one: the old token stops working and a new one is issued. */
async function promote(db: Sql, token: string, user: SessionUser, meta: ClientMeta) {
  await db`delete from sessions where token_hash = ${tokenHash(token)}`
  await withTenant(db, user.tenantId, async (tx) => {
    await tx`update users set failed_logins = 0, locked_until = null where id = ${user.userId}`
    await auditAuth(tx, user.userId, 'login', meta, { secondFactor: true })
  })
  return createSession(db, user.userId, user.tenantId, false, meta)
}

/** Check the authenticator code (or a recovery code) for a pending login. Returns the new full session token, or null. */
export async function verifySecondFactor(db: Sql, token: string, code: string, meta: ClientMeta = {}): Promise<string | null> {
  const user = await pendingSession(db, token)
  const ok = await withTenant(db, user.tenantId, async (tx) => {
    const [u] = await tx`select totp_secret, totp_enabled_at, totp_last_step from users where id = ${user.userId} for update`
    if (!u?.totp_secret || !u.totp_enabled_at) return false
    const step = verifyCode(open(u.totp_secret), code, u.totp_last_step === null ? null : Number(u.totp_last_step))
    if (step !== null) {
      await tx`update users set totp_last_step = ${step} where id = ${user.userId}`
      return true
    }
    const clean = code.replace(/[\s-]/g, '').toLowerCase()
    if (clean.length < 10) return false
    const [used] = await tx`update recovery_codes set used_at = now()
                             where user_id = ${user.userId} and code_hash = ${tokenHash(clean)} and used_at is null returning 1`
    if (used) await auditAuth(tx, user.userId, 'recovery_code_used', meta)
    return !!used
  })
  if (!ok) {
    await recordFailure(db, user.tenantId, user.userId, 'second_factor_failed', meta)
    return null
  }
  return promote(db, token, user, meta)
}

/** Start setting up an authenticator for a pending login that has none yet: the secret to show. */
export async function beginSecondFactorSetup(db: Sql, token: string): Promise<{ secret: string; email: string }> {
  const user = await pendingSession(db, token)
  return withTenant(db, user.tenantId, async (tx) => {
    const [u] = await tx`select totp_secret, totp_enabled_at from users where id = ${user.userId} for update`
    if (u.totp_enabled_at) throw new DomainError('An authenticator is already set up for this login.', 'already_set_up', 409)
    if (u.totp_secret) return { secret: open(u.totp_secret), email: user.email }
    const secret = newSecret()
    await tx`update users set totp_secret = ${seal(secret)} where id = ${user.userId}`
    return { secret, email: user.email }
  })
}

/**
 * Finish setting up: the first code from the app proves it holds the secret. Returns the new
 * full session token and the recovery codes, which are shown once and kept only as hashes.
 */
export async function finishSecondFactorSetup(db: Sql, token: string, code: string, meta: ClientMeta = {}):
  Promise<{ token: string; recoveryCodes: string[] } | null> {
  const user = await pendingSession(db, token)
  const codes = await withTenant(db, user.tenantId, async (tx) => {
    const [u] = await tx`select totp_secret, totp_enabled_at from users where id = ${user.userId} for update`
    if (!u.totp_secret || u.totp_enabled_at) return null
    const step = verifyCode(open(u.totp_secret), code, null)
    if (step === null) return null
    await tx`update users set totp_enabled_at = now(), totp_last_step = ${step} where id = ${user.userId}`
    const out = await newRecoveryCodes(tx, user.userId)
    await auditAuth(tx, user.userId, 'second_factor_set_up', meta)
    return out
  })
  if (!codes) {
    await recordFailure(db, user.tenantId, user.userId, 'second_factor_failed', meta)
    return null
  }
  return { token: await promote(db, token, user, meta), recoveryCodes: codes }
}

async function newRecoveryCodes(tx: Tx, userId: string): Promise<string[]> {
  await tx`delete from recovery_codes where user_id = ${userId}`
  const codes = Array.from({ length: security.recoveryCodes }, () => randomBytes(8).toString('hex').replace(/(.{4})(?=.)/g, '$1-'))
  for (const c of codes) {
    await tx`insert into recovery_codes (tenant_id, user_id, code_hash)
             values (current_setting('app.tenant_id')::uuid, ${userId}, ${tokenHash(c.replace(/-/g, ''))})`
  }
  return codes
}
