import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import {
  beginSecondFactorSetup, finishSecondFactorSetup, login, loginFailedMessage, logout, verifySecondFactor,
} from '../domain/auth.js'
import { security } from '../security/config.js'
import { otpauthUri } from '../security/totp.js'
import { clientIp, type Ctx, type Env } from './app.js'
import { Layout } from './layout.js'

/**
 * Logging in: email and password, then for pharmacists and managers a six-digit code from an
 * authenticator app. The first time, the app is set up here and recovery codes are shown once.
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

  r.get('/login/2fa', (c) => c.html(
    <Box title="Second step" err={c.req.query('err')}>
      <p>Open the authenticator app on your phone and type the six-digit code for sylken.</p>
      <form method="post" action="/login/2fa" style="display:grid;gap:10px">
        <label class="f">Code<input name="code" inputmode="numeric" autocomplete="one-time-code" autofocus required maxlength={24} /></label>
        <button type="submit">Continue</button>
      </form>
      <p class="hint">Lost your phone? Type one of your recovery codes instead, or ask a manager to reset your second step.</p>
      <p><a href="/logout">Cancel</a></p>
    </Box>,
  ))

  r.post('/login/2fa', async (c) => {
    const body = await c.req.parseBody()
    const token = await verifySecondFactor(c.get('db'), getCookie(c, SESSION_COOKIE)!, String(body.code ?? ''), meta(c))
    if (!token) return c.redirect('/login/2fa?err=' + encodeURIComponent('That code is not right. Check the time on your phone and try the newest code.'))
    setSession(c, token)
    return c.redirect('/')
  })

  r.get('/login/2fa/setup', async (c) => {
    const { secret, email } = await beginSecondFactorSetup(c.get('db'), getCookie(c, SESSION_COOKIE)!)
    c.header('cache-control', 'no-store')
    return c.html(
      <Box title="Set up the second step" err={c.req.query('err')}>
        <p>Pharmacists and managers need a code from their phone each time they log in, so a stolen password is not enough on its own.</p>
        <ol>
          <li>Install an authenticator app on your phone (Google Authenticator or Microsoft Authenticator).</li>
          <li>In the app choose <b>Add account</b>, then <b>Enter a setup key</b>.</li>
          <li>Account name: <b>sylken</b>. Key: <code style="font-size:16px;word-break:break-all">{secret.replace(/(.{4})/g, '$1 ').trim()}</code>. Type: time based.</li>
          <li>Type the six-digit code the app shows below.</li>
        </ol>
        <p class="hint">On a phone you can tap <a href={otpauthUri(secret, email)}>this link</a> instead of typing the key.</p>
        <form method="post" action="/login/2fa/setup" style="display:grid;gap:10px">
          <label class="f">Code from the app<input name="code" inputmode="numeric" autocomplete="one-time-code" autofocus required maxlength={8} /></label>
          <button type="submit">Finish setting up</button>
        </form>
        <p><a href="/logout">Cancel</a></p>
      </Box>,
    )
  })

  r.post('/login/2fa/setup', async (c) => {
    const body = await c.req.parseBody()
    const res = await finishSecondFactorSetup(c.get('db'), getCookie(c, SESSION_COOKIE)!, String(body.code ?? ''), meta(c))
    if (!res) return c.redirect('/login/2fa/setup?err=' + encodeURIComponent('That code is not right. Check the key was typed exactly and try the newest code.'))
    setSession(c, res.token)
    c.header('cache-control', 'no-store')
    return c.html(
      <Box title="Recovery codes" ok="Your second step is set up.">
        <p><b>Write these recovery codes down and keep them somewhere safe, away from your phone.</b> Each one works once, in place of a code from the app, if your phone is lost. They will not be shown again.</p>
        <pre style="font-size:16px;line-height:1.6">{res.recoveryCodes.join('\n')}</pre>
        <p><a class="btn" href="/">I have written them down</a></p>
      </Box>,
    )
  })

  return r
}
