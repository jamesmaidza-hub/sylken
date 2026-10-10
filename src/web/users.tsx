import { Hono } from 'hono'
import { deleteCookie } from 'hono/cookie'
import {
  changeOwnPassword, createUser, getUser, listUsers, resetSecondFactor, setPassword, unlockUser, updateUser,
} from '../domain/users.js'
import { security } from '../security/config.js'
import { permissions, roleLabels, rolePermissions, roles, type Role } from '../security/roles.js'
import { back, page, run, type Env } from './app.js'
import { dateTime } from './layout.js'
import { SESSION_COOKIE } from './login.js'

/** Managers add logins, set roles, unlock and reset them. Everyone can change their own password at /me. */

const rolesFrom = (b: Record<string, unknown>) => roles.filter((r) => b[`role_${r}`] === 'on')

function RoleBoxes(props: { checked?: Role[] }) {
  return (
    <div style="grid-column:1/-1;display:flex;gap:16px;flex-wrap:wrap">
      {roles.map((r) => (
        <label class="row" style="flex-direction:row"><input type="checkbox" name={`role_${r}`} checked={props.checked?.includes(r)} /> {roleLabels[r]}</label>
      ))}
    </div>
  )
}

function RoleTable() {
  return (
    <details><summary>What each role may do</summary>
      <div class="wrap"><table>
        <thead><tr><th>Permission</th>{roles.map((r) => <th>{roleLabels[r]}</th>)}</tr></thead>
        <tbody>{Object.entries(permissions).map(([p, label]) => (
          <tr><td>{label}</td>{roles.map((r) => <td>{(rolePermissions[r] as readonly string[]).includes(p) ? '✓' : ''}</td>)}</tr>
        ))}</tbody>
      </table></div>
      <p class="hint">Pharmacists and managers must use a code from an authenticator app at every login.</p>
    </details>
  )
}

export function userRoutes() {
  const r = new Hono<Env>()

  r.get('/', async (c) => {
    const users = await run(c, listUsers)
    return page(c, 'Users', (
      <>
        <h1>Users</h1>
        <div class="wrap"><table>
          <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Second step</th><th>Status</th></tr></thead>
          <tbody>{users.map((u) => (
            <tr data-href={`/users/${u.id}`}><td><a href={`/users/${u.id}`}>{u.name}</a></td><td>{u.email}</td>
              <td>{u.roles.map((x) => roleLabels[x]).join(', ')}</td><td>{u.secondFactor ? 'set up' : ''}</td>
              <td>{!u.active ? 'switched off' : u.lockedUntil ? `locked until ${dateTime(u.lockedUntil)}` : 'active'}</td></tr>
          ))}</tbody>
        </table></div>
        <h2>Add a login</h2>
        <form method="post" action="/users" class="grid panel">
          <label>Name<input name="name" required /></label>
          <label>Email<input name="email" type="email" required /></label>
          <label>First password<input name="password" type="password" required minlength={security.minPasswordLength} autocomplete="new-password" /></label>
          <RoleBoxes />
          <div><button>Add login</button></div>
        </form>
        <p class="hint">Each person gets their own login; never share one. Tell them their first password in person and ask them to change it under their name at the top of the screen.</p>
        <RoleTable />
      </>
    ))
  })

  r.post('/', async (c) => {
    const b = await c.req.parseBody()
    const id = await run(c, (tx) => createUser(tx, { name: String(b.name ?? ''), email: String(b.email ?? ''), password: String(b.password ?? ''), roles: rolesFrom(b) }, c.get('user').userId))
    return back(c, `/users/${id}`, { ok: 'Login added' })
  })

  r.get('/:id', async (c) => {
    const u = await run(c, (tx) => getUser(tx, c.req.param('id')))
    if (!u) return c.notFound()
    return page(c, u.name, (
      <>
        <div class="row"><h1>{u.name}</h1><span class="spacer" /><a class="btn secondary" href="/users">All users</a></div>
        <form method="post" action={`/users/${u.id}`} class="grid panel">
          <label>Name<input name="name" value={u.name} required /></label>
          <label>Email<input name="email" type="email" value={u.email} required /></label>
          <RoleBoxes checked={u.roles} />
          <label class="row" style="flex-direction:row"><input type="checkbox" name="active" checked={u.active} /> Login switched on</label>
          <div><button>Save</button></div>
        </form>
        <p class="hint">Changing roles or switching a login off logs that person out everywhere.</p>
        <h2>Password and second step</h2>
        <form method="post" action={`/users/${u.id}/password`} class="grid panel">
          <label>New password<input name="password" type="password" required minlength={security.minPasswordLength} autocomplete="new-password" /></label>
          <div><button>Set password</button></div>
        </form>
        <div class="row">
          {u.lockedUntil && <form method="post" action={`/users/${u.id}/unlock`}><button>Unlock now</button></form>}
          {u.secondFactor && <form method="post" action={`/users/${u.id}/reset-2fa`}><button class="danger">Reset second step (lost phone)</button></form>}
        </div>
        <p class="muted">{u.lockedUntil ? `Locked after too many wrong tries, until ${dateTime(u.lockedUntil)}.` : ''}</p>
      </>
    ))
  })

  r.post('/:id', async (c) => {
    const b = await c.req.parseBody()
    await run(c, (tx) => updateUser(tx, c.req.param('id'), { name: String(b.name ?? ''), email: String(b.email ?? ''), roles: rolesFrom(b), active: b.active === 'on' }, c.get('user').userId))
    return back(c, `/users/${c.req.param('id')}`, { ok: 'Saved' })
  })

  r.post('/:id/password', async (c) => {
    const b = await c.req.parseBody()
    await run(c, (tx) => setPassword(tx, c.req.param('id'), String(b.password ?? ''), c.get('user').userId))
    return back(c, `/users/${c.req.param('id')}`, { ok: 'Password set. They are logged out everywhere.' })
  })

  r.post('/:id/unlock', async (c) => {
    await run(c, (tx) => unlockUser(tx, c.req.param('id'), c.get('user').userId))
    return back(c, `/users/${c.req.param('id')}`, { ok: 'Unlocked' })
  })

  r.post('/:id/reset-2fa', async (c) => {
    await run(c, (tx) => resetSecondFactor(tx, c.req.param('id'), c.get('user').userId))
    return back(c, `/users/${c.req.param('id')}`, { ok: 'Second step reset. They set up a new one at their next login.' })
  })

  return r
}

export function meRoutes() {
  const r = new Hono<Env>()

  r.get('/', (c) => {
    const u = c.get('user')
    return page(c, 'My login', (
      <>
        <h1>{u.name}</h1>
        <p>{u.email} · {u.roles.map((x) => roleLabels[x]).join(', ')} · {u.tenantName}</p>
        <h2>Change my password</h2>
        <form method="post" action="/me/password" class="grid panel">
          <label>Current password<input name="current" type="password" required autocomplete="current-password" /></label>
          <label>New password<input name="password" type="password" required minlength={security.minPasswordLength} autocomplete="new-password" /></label>
          <div><button>Change password</button></div>
        </form>
        <p class="hint">At least {security.minPasswordLength} characters. You will be asked to log in again.</p>
      </>
    ))
  })

  r.post('/password', async (c) => {
    const b = await c.req.parseBody()
    await run(c, (tx) => changeOwnPassword(tx, c.get('user').userId, String(b.current ?? ''), String(b.password ?? '')))
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.redirect('/login?err=' + encodeURIComponent('Password changed. Log in with the new one.'))
  })

  return r
}
