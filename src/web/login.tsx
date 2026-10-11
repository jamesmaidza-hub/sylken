import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { login, loginFailedMessage, logout, needsPinSetup, setUpSecondPin, verifySecondFactor } from '../domain/auth.js'
import { DomainError } from '../domain/errors.js'
import { security } from '../security/config.js'
import { clientIp, type Ctx, type Env } from './app.js'
import { Layout } from './layout.js'

/**
 * Logging in: email and password, then for pharmacists and managers a second PIN. The first
 * time (or after a manager resets it) they choose the PIN here.
 */

export const SESSION_COOKIE = 'sylken_session'

function setSession(c: Ctx, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'Strict', path: '/', secure: process.env.NODE_ENV === 'production',
    maxAge: security.absoluteHours * 3600,
  })
}

const meta = (c: Ctx) => ({ ip: clientIp(c), userAgent: c.req.header('user-agent') ?? null })

function Box(props: { title: string; err?: string; ok?: string; children?: any }) {
  return (
    <Layout title={props.title} flash={{ err: props.err, ok: props.ok }}>
      <div class="panel" style="max-width:420px;margin:10vh auto">
        <h1>sylken</h1>
        {props.children}
      </div>
    </Layout>
  )
}

export function loginRoutes() {
  const r = new Hono<Env>()

  r.get('/login', (c) => c.html(
    <Box title="Log in" err={c.req.query('err')} ok={c.req.query('idle') ? `You were logged out after ${security.idleMinutes} minutes without use.` : undefined}>
      <form method="post" action="/login" style="display:grid;gap:10px">
        <label class="f">Email<input name="email" type="email" autofocus required autocomplete="username" /></label>
        <label class="f">Password<input name="password" type="password" required autocomplete="current-password" /></label>
        <button type="submit">Log in</button>
      </form>
    </Box>,
  ))

  r.post('/login', async (c) => {
    const ip = clientIp(c) ?? 'unknown'
    if (!c.get('loginLimiter').take(ip)) {
      return c.redirect('/login?err=' + encodeURIComponent('Too many login attempts from this computer. Wait a few minutes and try again.'))
    }
    const body = await c.req.parseBody()
    const res = await login(c.get('db'), String(body.email ?? ''), String(body.password ?? ''), meta(c))
    if (!res.ok) return c.redirect('/login?err=' + encodeURIComponent(loginFailedMessage))
    setSession(c, res.token)
    return c.redirect(res.next === 'done' ? '/' : res.next === 'second_factor' ? '/login/2fa' : '/login/2fa/setup')
  })

  r.get('/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE)
    if (token) await logout(c.get('db'), token)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.redirect(c.req.query('idle') ? '/login?idle=1' : '/login')
  })

  r.get('/login/2fa', async (c) => {
    if (await needsPinSetup(c.get('db'), getCookie(c, SESSION_COOKIE)!)) return c.redirect('/login/2fa/setup')
    return c.html(
      <Box title="Second PIN" err={c.req.query('err')}>
        <p>Pharmacists and managers type their second PIN as well as the password.</p>
        <form method="post" action="/login/2fa" style="display:grid;gap:10px">
          <label class="f">Second PIN<input name="pin" type="password" inputmode="numeric" autocomplete="off" autofocus required maxlength={20} /></label>
          <button type="submit">Continue</button>
        </form>
        <p class="hint">Forgot it? Ask a manager to reset your second PIN.</p>
        <p><a href="/logout">Cancel</a></p>
      </Box>,
    )
  })

  r.post('/login/2fa', async (c) => {
    const body = await c.req.parseBody()
    const token = await verifySecondFactor(c.get('db'), getCookie(c, SESSION_COOKIE)!, String(body.pin ?? ''), meta(c))
    if (!token) return c.redirect('/login/2fa?err=' + encodeURIComponent(`That PIN is not right. After ${security.maxFailures} wrong tries in a row the login locks for ${security.lockMinutes} minutes.`))
    setSession(c, token)
    return c.redirect('/')
  })

  r.get('/login/2fa/setup', async (c) => {
    if (!(await needsPinSetup(c.get('db'), getCookie(c, SESSION_COOKIE)!))) return c.redirect('/login/2fa')
    return c.html(
      <Box title="Choose a second PIN" err={c.req.query('err')}>
        <p>Pharmacists and managers type a second PIN after the password each time they log in. Choose one now.</p>
        <form method="post" action="/login/2fa/setup" style="display:grid;gap:10px">
          <label class="f">New second PIN ({security.minPinLength} or more digits)<input name="pin" type="password" inputmode="numeric" autocomplete="off" autofocus required minlength={security.minPinLength} maxlength={20} /></label>
          <label class="f">Type it again<input name="again" type="password" inputmode="numeric" autocomplete="off" required minlength={security.minPinLength} maxlength={20} /></label>
          <button type="submit">Save PIN and continue</button>
        </form>
        <p class="hint">Not your birthday, not 123456, and not one digit repeated. Don't write it next to the password.</p>
        <p><a href="/logout">Cancel</a></p>
      </Box>,
    )
  })

  r.post('/login/2fa/setup', async (c) => {
    const body = await c.req.parseBody()
    try {
      const token = await setUpSecondPin(c.get('db'), getCookie(c, SESSION_COOKIE)!, String(body.pin ?? ''), String(body.again ?? ''), meta(c))
      setSession(c, token)
      return c.redirect('/?ok=' + encodeURIComponent('Second PIN saved.'))
    } catch (e) {
      if (e instanceof DomainError && e.status !== 401) return c.redirect('/login/2fa/setup?err=' + encodeURIComponent(e.message))
      throw e
    }
  })

  return r
}
