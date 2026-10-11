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
| 1.9 | Pharmacists and managers get a short "pending" session after the password that only reaches the second-PIN pages. They choose the PIN at first login: at least 6 digits, not one digit repeated, not a run like 123456, not the password. It is stored only as a salted scrypt hash, and wrong PINs count towards the lockout. (Replaced the authenticator app on 2026-10-11 at james's request; see risk 15.) | `login.test.ts` "1.9 second PIN" |
| 1.10 | Managers reset a forgotten PIN and the person chooses a new one at next login; `npm run user:reset -- --reset-2fa` does it from the server. An existing PIN can't be replaced from the login screens. | `login.test.ts` "lets a manager reset a forgotten PIN", "cannot replace an existing PIN" |
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

- That staff don't share logins, passwords or second PINs.
- Login timing is equalised by design but not measured by a test.
- Where the encryption key lives and who can read it (see risks 6).

## Risks, trade-offs and assumptions

1. **Found in this review, not fixed here (section 3):** the app's own database login can switch on the `sylken.purge` setting, and then rewrite a dispensed script and delete the whole audit log. I confirmed this with a test against a fake pharmacy. It is the first thing section 3 fixes.
2. **Lockout can be used to annoy.** Anyone who knows an email can lock that login for 15 minutes. People already logged in stay logged in, and the per-IP limit slows this down, but it can't be prevented entirely while lockout exists.
3. **Choosing the first PIN trusts whoever logs in first.** Someone who learns a new person's first password before they log in could choose the PIN themselves. The manager should give the first password in person and the person should log in straight away.
4. **The check is optional** (james, 2026-10-11: "no second person"). When someone checks a script, sylken records it and refuses a self-check. But labels print and patients are served without any check, so a script dispensed and handed over by one person has had no second pair of eyes. The script screen shows "Not checked yet" for these.
5. **Dispensers can't dispense for any patient with an allergy on record**, because today every allergy raises a warning that needs ticking. Section 4 narrows this to real conflicts, with a recorded reason.
6. **The encryption key.** On the shop PC it is created in the sylken folder (`data/sylken.key`). That keeps it out of database backups, but anyone who takes the PC has both, so the disk needs BitLocker. The key must be backed up separately. Nothing uses it yet; section 2 encrypts patient fields with it.
7. **The per-IP limit is held in memory**, so it resets when sylken restarts and only works with one app process.
8. **The till logs out after 15 minutes with no sales.** Sales already rung up stay on the till and send after logging in again. The till screen itself has no idle lock because it shows no patient details and the lock would throw away a half-rung sale.
9. **Who rang a sale is still taken from the till** for offline sales, so a till user could put a sale under someone else's name. The cashier codes being built in "Dispensers and dispensing codes" replace this; I will line the two up when that lands.
10. **Refunds at the till don't need a pharmacist yet.** The brief says returns need a pharmacist. The till works offline, so the proposal is that refunds sync as "waiting for approval" and show in cash-up problems. Not built.
11. **Managers don't see clinical data** unless they are also pharmacists. A manager-only login gets dispensary totals but not patients, scripts or the register.
12. **Dispenser codes.** The checker rule compares with the logged-in person who dispensed. When dispenser codes land, it must compare with the person behind the code.
13. The old `POST /api/movements` (raw stock movements, used by nothing in the app) is now manager only; section 3 proposes removing it.
14. Smaller items for section 5: `GET /logout` can be triggered from another site (forced logout only), and the owed-item hand-over form follows a `from` address it is given.
15. **The second step is a PIN, not a true second factor** (james, 2026-10-11). The password and the PIN are both things a person knows, so anyone who watches both being typed, or finds them written down together, can log in as that pharmacist or manager. An authenticator app on a phone would also need the phone. The PIN still stops a password guessed or reused from elsewhere on its own, and wrong PINs count towards the lockout. If sylken is hosted online for other pharmacies, a real second factor should come back for logins from outside the shop.

## When this is deployed

Everyone logs in again. james's login becomes pharmacist + manager, so at his next login he chooses a second PIN of at least 6 digits.
