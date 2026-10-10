# Section 1: access and roles

Requirements 1.1 to 1.19 in [requirements.md](requirements.md). This file says how each is built,
which test proves it, and what is still open. All tests use made-up people and items.

## Where the code is

| Concern | File |
|---|---|
| Roles and what each may do | `src/security/roles.ts` |
| The permission every route needs (deny by default) | `src/security/routes.ts` |
| Timeouts and limits, in one place | `src/security/config.ts` |
| Authenticator codes (RFC 6238) | `src/security/totp.ts` |
| Field encryption and token hashing | `src/security/crypto.ts` |
| Per-IP login limit | `src/security/ratelimit.ts` |
| Login, second factor, sessions, lockout | `src/domain/auth.ts` |
| Managing logins | `src/domain/users.ts`, screens in `src/web/users.tsx` |
| Login screens | `src/web/login.tsx` |
| Independent checking | `src/domain/checks.ts`, trigger in `migrations/008_access.sql` |
| Tests | `test/security/access.test.ts`, `login.test.ts`, `checking.test.ts` |

## Implementation and tests

| # | How it is built | Proved by |
|---|---|---|
| 1.1 | A middleware reads the session; the guard sends anyone without one to `/login` (or 401 for the API). Only routes marked `public` skip it. | `access.test.ts` "needs a login for everything…" calls every route with no session |
| 1.2 | `users.roles` is a set, checked by a database constraint. Existing owners became pharmacist + manager, so nobody lost access in the migration. | `access.test.ts` "gives each role exactly the brief's limits" |
| 1.3 | `src/security/routes.ts` lists every route with one permission. The guard looks up the route the router actually matched (not the raw URL), and refuses anything not listed. Checks inside a route (overrides) use `requirePermission`. | `access.test.ts`: the table matches the app's routes exactly; an unlisted route is refused even for a manager; for each role, every route it lacks answers 403 and every screen it has opens |
| 1.4 | Assistants hold no `rx.*` permission. The till can still look up a script by number to take payment. | `access.test.ts` "1.4 counter assistants" |
| 1.5 | Dispensers hold `rx.dispense` but not `rx.override`. Ticking an allergy/alert or stock override needs `rx.override`; the screen tells a dispenser a pharmacist must dispense it. | `access.test.ts` "1.5 dispensers cannot override warnings" |
| 1.6 | `rx.reverse`, `rx.override`, `rx.flags.remove` and `rx.check` are pharmacist only. | `access.test.ts` "1.6" and the role sweep |
| 1.7 | `stock.adjust` and `users.manage` are manager only. | `access.test.ts` "1.7" |
| 1.8 | Checking is a separate record (`script_checks`). The server refuses your own work, and a database trigger refuses it too, so code that skips the server check still can't. A check can never be changed or deleted. | `checking.test.ts` |
| 1.9 | Pharmacists and managers get a short "pending" session after the password that only reaches the second-step pages. Codes are 6-digit TOTP, one step of clock drift allowed, and each code works once. The secret is encrypted with AES-256-GCM. | `login.test.ts` "1.9", including the RFC 6238 test vector |
| 1.10 | Ten recovery codes shown once, stored as SHA-256 hashes, each usable once. Managers reset a lost authenticator; `npm run user:reset` does it from the server. | `login.test.ts` "accepts each recovery code once" |
| 1.11 | Sessions end 15 minutes after the last request and 12 hours after login, checked on every request. The till's background polling sends a header so it doesn't count as activity. | `login.test.ts` "1.11 and 1.15 sessions" |
| 1.12 | Every logged-in screen logs itself out after 15 minutes without mouse, key or touch. | `login.test.ts` "puts an idle lock on every logged-in screen" |
| 1.13 | 5 wrong passwords or codes in a row lock the login for 15 minutes; managers can unlock. Separately, one IP address gets 20 attempts per 15 minutes across all emails. | `login.test.ts` "1.13 lockout" |
| 1.14 | One message for unknown email, wrong password and locked; an unknown email still runs a password hash. | `login.test.ts` "gives the same answer…" (message only; timing is not measured) |
| 1.15 | Only SHA-256 hashes of session tokens are stored. | `login.test.ts` "keeps only a hash of the token" |
| 1.16 | After the second step the pending token is deleted and a new one issued. Changing roles, email, password or active ends that person's sessions. | `login.test.ts` "issues a new session token…", "ends someone's sessions…" |
| 1.17 | At least 10 characters and not the email. | `login.test.ts` "refuses short passwords…" |
| 1.18 | A manager can't drop their own manager role or switch themselves off, and the pharmacy must keep one active manager. | `login.test.ts` "stops a manager removing…" |
| 1.19 | Logins, failures, lockouts, second-step changes and user changes (with before/after) go to `audit_log` with the IP. | `login.test.ts` "writes logins, failures…" |

## What I could not verify

- That the clock on the shop PC and the server is right. Authenticator codes fail if it drifts by more than about a minute. Windows time sync should be on.
- How the authenticator setup goes for real staff on their own phones. The setup page uses a typed key and a phone link; there is no QR code yet.
- That staff don't share logins or let someone else use their phone.
- Login timing is equalised by design but not measured by a test.
- Where the encryption key lives and who can read it (see risks 6).

## Risks, trade-offs and assumptions

1. **Found in this review, not fixed here (section 3):** the app's own database login can switch on the `sylken.purge` setting, and then rewrite a dispensed script and delete the whole audit log. I confirmed this with a test against a fake pharmacy. It is the first thing section 3 fixes.
2. **Lockout can be used to annoy.** Anyone who knows an email can lock that login for 15 minutes. People already logged in stay logged in, and the per-IP limit slows this down, but it can't be prevented entirely while lockout exists.
3. **First authenticator setup trusts whoever logs in first.** Someone who learns a new person's first password before they log in could set up their own phone. The manager should give the first password in person and the person should log in straight away.
4. **A pharmacist alone on shift can't check their own work.** The check is recorded and enforced, but it is **not yet required** before labels print or the patient is served. Whether it should be, and what happens on a one-pharmacist shift, is james's call.
5. **Dispensers can't dispense for any patient with an allergy on record**, because today every allergy raises a warning that needs ticking. Section 4 narrows this to real conflicts, with a recorded reason.
6. **The encryption key.** On the shop PC it is created in the sylken folder (`data/sylken.key`). That keeps it out of database backups, but anyone who takes the PC has both, so the disk needs BitLocker. The key must be backed up separately: losing it means every pharmacist and manager has to reset their authenticator.
7. **The per-IP limit is held in memory**, so it resets when sylken restarts and only works with one app process.
8. **The till logs out after 15 minutes with no sales.** Sales already rung up stay on the till and send after logging in again. The till screen itself has no idle lock because it shows no patient details and the lock would throw away a half-rung sale.
9. **Who rang a sale is still taken from the till** for offline sales, so a till user could put a sale under someone else's name. The cashier codes being built in "Dispensers and dispensing codes" replace this; I will line the two up when that lands.
10. **Refunds at the till don't need a pharmacist yet.** The brief says returns need a pharmacist. The till works offline, so the proposal is that refunds sync as "waiting for approval" and show in cash-up problems. Not built.
11. **Managers don't see clinical data** unless they are also pharmacists. A manager-only login gets dispensary totals but not patients, scripts or the register.
12. **Dispenser codes.** The checker rule compares with the logged-in person who dispensed. When dispenser codes land, it must compare with the person behind the code.
13. The old `POST /api/movements` (raw stock movements, used by nothing in the app) is now manager only; section 3 proposes removing it.
14. Smaller items for section 5: `GET /logout` can be triggered from another site (forced logout only), and the owed-item hand-over form follows a `from` address it is given.

## When this is deployed

Everyone logs in again. james's login becomes pharmacist + manager, so he will be asked to set up an authenticator app on his phone at his next login and to write down ten recovery codes.
