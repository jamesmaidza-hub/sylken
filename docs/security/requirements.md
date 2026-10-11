# sylken security requirements

Testable security and record-integrity requirements for sylken, a multi-pharmacy dispensing,
till and stock system holding patient health data (Botswana).

Rules for this list:

- **[Added]** marks a requirement that was not in james's brief.
- **Today** is what the code on `main` did when this list was written (2026-10-10, commit `1d3df09`),
  checked by reading the code and running the tests. It is not a claim that anything is "secure".
  - ✅ covered, with where it lives
  - 🟡 partly covered
  - ❌ missing
  - 👤 cannot be proved by a code test; a person must check it (see the end of the list)
- Each requirement names the test that proves it once its section is built. Tests use fake data only.
- Sections are built one at a time, in this order. Status is updated as each section's PR lands.

---

## 1. Access and roles

| # | Requirement | Today |
|---|---|---|
| 1.1 | Every screen and API call except `/login`, `/health` and the login second-factor pages needs a logged-in session. | ✅ `src/web/app.tsx` session middleware |
| 1.2 | The roles are **counter assistant**, **dispenser**, **pharmacist** and **manager**. A person can hold more than one (an owner-pharmacist is pharmacist + manager). | ❌ roles were owner / pharmacist / assistant, one each |
| 1.3 | Permissions are checked on the server for every request from one central table. A route missing from the table is refused (deny by default). | 🟡 about 25 routes had inline checks; the rest had none |
| 1.4 | Counter assistants cannot open patients, scripts, clinical notes, allergies or the register, and cannot dispense. | ❌ assistants could open every patient and capture scripts |
| 1.5 | Dispensers can capture and dispense, but cannot override a clinical warning (allergy, alert, old script) or a stock warning. | ❌ no dispenser role |
| 1.6 | Only pharmacists approve overrides, reverse a dispensed script (return), cancel owed items and remove an allergy. | 🟡 owner or pharmacist, so a non-pharmacist owner could |
| 1.7 | Only managers adjust stock (stock takes, min/max) and manage users. | 🟡 stock takes allowed pharmacists; no user management at all |
| 1.8 | The person who checks a script is not the person who dispensed it, enforced in the database as well as the server. | ❌ no checking step |
| 1.9 | A second factor (authenticator-app code, TOTP) for every pharmacist and manager login. | ❌ |
| 1.10 | **[Added]** One-time recovery codes for the second factor, stored only as hashes; a manager can reset another user's second factor; a command-line reset exists for the last manager. | ❌ |
| 1.11 | Sessions end after 15 minutes without activity and 12 hours after login, enforced on the server. | ❌ sessions lasted 14 days |
| 1.12 | Screens lock (log out) in the browser after 15 minutes idle, so patient data is not left on an unattended screen. | ❌ |
| 1.13 | After 5 wrong passwords or codes in a row an account is locked for 15 minutes; a manager can unlock it early. | ❌ |
| 1.14 | **[Added]** Login gives the same message and takes about the same time whether or not the email exists. | 🟡 same message; timing differed |
| 1.15 | **[Added]** Session tokens are stored only as hashes, so a copy of the database cannot be used to log in. | ❌ stored in plain |
| 1.16 | **[Added]** A new session token is issued after the second factor (no session fixation), and changing a user's roles, password or active flag ends their sessions. | ❌ |
| 1.17 | **[Added]** Passwords are at least 10 characters and not the email address. | ❌ |
| 1.18 | **[Added]** A manager cannot remove their own manager role or deactivate themselves, so a pharmacy always keeps one manager. | ❌ |
| 1.19 | **[Added]** Logins, failed logins, lockouts, second-factor changes and user changes go to the audit log with the IP address. | ❌ |

**After section 1:** 1.1 to 1.19 are built and tested; how, and what is still open, is in
[section-1-access.md](section-1-access.md). Tests: `test/security/access.test.ts`,
`test/security/login.test.ts`, `test/security/checking.test.ts`.

## 2. Data separation and protection

| # | Requirement | Today |
|---|---|---|
| 2.1 | Every business table has `tenant_id` and forced row-level security; the app's database role cannot bypass it. | ✅ all tables in migrations 001, 003, 004 except `sessions` and `tenants` |
| 2.2 | A test proves pharmacy A can neither read nor change pharmacy B's data through the database, every web screen and the API (ids from B used while logged in to A). | 🟡 database-level test only |
| 2.3 | **[Added]** A test fails the build if any table is added without tenant row-level security. | ❌ |
| 2.4 | TLS on every connection from browsers; HTTP redirects to HTTPS; HSTS header. | 🟡 Caddy in `docker-compose.yml` gives TLS on a server; the shop PC runs plain HTTP on localhost 👤 |
| 2.5 | Sensitive fields encrypted at rest with a key kept outside the database: patient ID/passport number, medical aid member number, phone, address, clinical notes, second-factor secrets, QuickBooks tokens. | ❌ |
| 2.6 | Passwords stored only as salted, slow hashes. | ✅ scrypt with a random salt (`src/domain/auth.ts`); brief asked for argon2 or bcrypt, see open risks |
| 2.7 | **[Added]** Hash cost raised to current guidance (scrypt N=2^17, r=8, p=1) and old hashes upgraded at next login. | ❌ N=2^14 |
| 2.8 | No secrets, keys or passwords in code or git history; a scanner runs in CI. | 🟡 `.env` ignored; `.env.example` holds `change-me` placeholders; no scanner |
| 2.9 | Collect only needed patient data; screens that do not need patient details mask them (till shows initials, reports mask ID numbers). | ❌ till script lookup returns the full patient name |
| 2.10 | **[Added]** Database connections from the app use a non-owner role without BYPASSRLS; the schema owner is used only for migrations. | ✅ `sylken_app` role, `src/db/migrate.ts` |

## 3. Records and audit

| # | Requirement | Today |
|---|---|---|
| 3.1 | Append-only audit log of who, what, when, from where (IP, device) and before/after values. | 🟡 `audit_log` has who/what/when; no IP, no before/after on most actions |
| 3.2 | Nobody can edit or delete the audit log, including through the app's database role. | ❌ the app role can update and delete it |
| 3.3 | **[Added]** Each audit row carries a hash of the previous row (hash chain) so a deleted or edited row is detectable even by someone with database owner rights. | ❌ |
| 3.4 | Every view of a patient record, script, label or patient-level report is logged. | ❌ |
| 3.5 | Clinical, stock and sales records are never deleted; they are voided or corrected with history kept. | 🟡 stock ledger, sales and dispensed scripts are immutable by trigger; patients, doctors, flags and items have no delete route but no trigger either |
| 3.6 | **[Added]** The immutability triggers cannot be switched off by the app role (today `set_config('sylken.purge','on')` from the app connection disables them). | ❌ found in this review and confirmed with a test: the app login can rewrite a dispensed script and empty the audit log |
| 3.7 | Stock changes only through recorded movements (sale, dispense, delivery, write-off, stock take); `stock_levels` cannot be written directly by the app role. | 🟡 ledger trigger maintains levels; the app role still has update on `stock_levels` |
| 3.8 | Money stored as whole thebe (integers), never floating point, in the database and in code. | ❌ stored as `numeric(12,2)` Pula (exact) but handled as JavaScript floating-point numbers |

## 4. Dispensing and labels

| # | Requirement | Today |
|---|---|---|
| 4.1 | An allergy conflict blocks dispensing until a pharmacist records a reason; the reason is stored with the script. | 🟡 a tick box, no reason, any dispensing role |
| 4.2 | Expired or recalled batches cannot be selected. | ❌ no batches or expiry dates are tracked |
| 4.3 | **[Added]** Batch number and expiry are captured on delivery and recorded on every dispensed line. | ❌ |
| 4.4 | Each label is stored as a snapshot exactly as dispensed, with a unique label number linking dispenser, checker, batch and time. | ❌ labels are rebuilt from the script each time |
| 4.5 | Reprints come from the snapshot, are byte-identical apart from a "COPY" mark, and are logged. | ❌ |
| 4.6 | A label with any required field missing is refused, not printed. | ❌ |
| 4.7 | Controlled medicines have a separate register with date-range reports. | 🟡 register built from the stock ledger with date range; schedules are a setting |
| 4.8 | **[Added]** The register cannot be edited; corrections are new entries referencing the old one. | 🟡 follows from the immutable ledger |

## 5. Input and application safety

| # | Requirement | Today |
|---|---|---|
| 5.1 | All input validated on the server. | 🟡 zod on the API; form posts use ad-hoc `String()`/`Number()` |
| 5.2 | Parameterised queries only. | 🟡 `postgres` tagged templates throughout; `unsafe()` used in migrations |
| 5.3 | All output escaped. | 🟡 Hono JSX escapes by default; `raw()` used for scripts/CSS |
| 5.4 | Rate-limit logins and sensitive actions. | ❌ |
| 5.5 | Generic error messages to users; details logged without patient data. | 🟡 500s are generic; `console.error(err)` may print patient data |
| 5.6 | Dependencies pinned (lockfile, exact versions) and scanned for known vulnerabilities in CI. | 🟡 lockfile present; `^` ranges; no scan |
| 5.7 | **[Added]** Security headers: Content-Security-Policy, X-Frame-Options/frame-ancestors, X-Content-Type-Options, Referrer-Policy. | ❌ |
| 5.8 | **[Added]** Cross-site request forgery protection on every form post. | 🟡 `SameSite=Strict` cookie only |
| 5.9 | **[Added]** Excel/CSV exports neutralise formula injection (cells starting with `= + - @`). | ❌ |

## 6. Integrations (QuickBooks)

| # | Requirement | Today |
|---|---|---|
| 6.1 | QuickBooks connection uses OAuth 2.0; no QuickBooks password is ever stored. | ❌ not built |
| 6.2 | Tokens stored encrypted (see 2.5); the pharmacy can disconnect at any time, which deletes the tokens and revokes them at Intuit. | ❌ |
| 6.3 | Only daily financial summaries are sent; a test asserts the payload holds no patient, doctor, script or account-holder fields. | ❌ |
| 6.4 | Every summary has a unique reference per pharmacy and day, so retries never create duplicates. | ❌ |
| 6.5 | **[Added]** Each send is logged with what was sent and the reply. | ❌ |

## 7. Resilience and ownership

| # | Requirement | Today |
|---|---|---|
| 7.1 | Encrypted automatic daily backups kept off the machine. | ❌ 👤 |
| 7.2 | A documented restore, tested by an automated restore of a fake-data backup. | ❌ |
| 7.3 | Any pharmacy can export all of its own data at any time. | 🟡 many reports export to Excel/CSV; no full export |
| 7.4 | When a subscription lapses, the pharmacy switches to read-only after a grace period, and can always still read and export its records. | ❌ no subscription state |
| 7.5 | Fail safe: on any error or doubt, access is denied, not allowed. | 🟡 unknown session → login; errors → 500. Section 1 adds deny-by-default routes |
| 7.6 | **[Added]** Clock and time zone: records use server time in UTC with the pharmacy's zone for display, so registers and audit times can't be back-dated from a till. | 🟡 offline till sends its own times |

---

## What a person must check (cannot be proved by sylken's own tests)

- Server and shop-PC configuration: TLS certificate, firewall, Windows accounts and disk encryption (BitLocker) on PHARMA3-PC, Postgres listening only on localhost.
- Where the encryption key and database passwords are kept, who can read them, and that they are backed up separately from the data.
- Backups actually run, leave the building, and restore (a restore drill at least every quarter).
- An independent penetration test before a second pharmacy goes live.
- Legal content of labels and the controlled-medicine register against Botswana's rules (the Medicines and Related Substances Act and BoMRA guidance), and the Data Protection Act 2018 duties (registration, breach notice, data held outside Botswana).
- Staff practices: no shared logins, phones used for the second factor kept by their owners.
