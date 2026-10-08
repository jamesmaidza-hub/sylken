import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Sql } from '../db/index.js'

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

export interface SessionUser {
  userId: string
  tenantId: string
  name: string
  role: 'owner' | 'pharmacist' | 'assistant'
  tenantName: string
}

const SESSION_DAYS = 14

export async function login(db: Sql, email: string, password: string): Promise<string | null> {
  const [u] = await db`select * from auth_lookup(${email})`
  if (!u || !u.active || !(await verifyPassword(password, u.password_hash))) return null
  const token = randomBytes(32).toString('base64url')
  await db`insert into sessions (token, user_id, tenant_id, expires_at)
           values (${token}, ${u.user_id}, ${u.tenant_id}, now() + ${SESSION_DAYS + ' days'}::interval)`
  return token
}

export async function sessionUser(db: Sql, token: string): Promise<SessionUser | null> {
  const [s] = await db`select user_id, tenant_id from sessions where token = ${token} and expires_at > now()`
  if (!s) return null
  return db.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${s.tenant_id}, true)`
    const [u] = await tx`select u.name, u.role, u.active, t.name as tenant_name from users u join tenants t on t.id = u.tenant_id where u.id = ${s.user_id}`
    if (!u || !u.active) return null
    return { userId: s.user_id, tenantId: s.tenant_id, name: u.name, role: u.role, tenantName: u.tenant_name } as SessionUser
  }) as Promise<SessionUser | null>
}

export async function logout(db: Sql, token: string) {
  await db`delete from sessions where token = ${token}`
}
