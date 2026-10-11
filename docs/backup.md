# Backups and restoring

sylken keeps all its data in one PostgreSQL database. A backup is a complete, consistent copy of that database, encrypted, made every night. This page covers what is backed up, how to set it up, and how to get everything back.

## What you get

- **A nightly backup** at 22:00 (Windows Task Scheduler), made from one snapshot, so the file and the row counts agree.
- **Encrypted** with AES-256-GCM using `SYLKEN_BACKUP_KEY` from `.env`. Someone who finds a backup file cannot read it, and a damaged or changed file is refused instead of restored.
- **A checksum and row counts** for each backup (`.meta.json` beside it) so a restore can be checked.
- **Kept for 30 days**, plus the first backup of each of the last 12 months. The newest backup is never deleted.
- **A second copy** if `SYLKEN_BACKUP_COPY_DIR` is set (see below), checked against the original.
- **A status line in Settings** that goes red if the last backup is over a day and a half old, if there is no second copy, or if the last attempt failed.

Backups go to `C:\Users\<you>\sylken-backups` (change it with `SYLKEN_BACKUP_DIR`).

## Setting it up on a computer

1. Put a backup key in `.env` (32 random bytes in base64). Make it once and never change it, or old backups cannot be read:
   ```
   openssl rand -base64 32
   ```
   ```
   SYLKEN_BACKUP_KEY=...
   ```
2. Run a backup by hand, then prove it restores:
   ```
   npm run backup
   npm run backup:verify
   ```
3. Schedule the nightly backup (from the sylken folder):
   ```
   powershell -ExecutionPolicy Bypass -File scripts\schedule-backup.ps1
   ```
   Use `-At 23:30` for another time, `-Remove` to take it away. If the computer is off at that time, the backup runs as soon as it can. Its output goes to `backup.log`.
4. **Set a second copy** (`SYLKEN_BACKUP_COPY_DIR` in `.env`, for example a USB drive such as `E:\sylken-backups`, or a folder that syncs to cloud storage you trust). A backup that only lives on the same computer is lost with it (fire, theft, a dead disk). The backups are encrypted, so a synced folder does not expose patient data without the key. Use a drive that stays plugged in, or swap two drives weekly.

## Keep these safe, away from the computer

Print them or keep them in a password manager. **Without the backup key the backups cannot be read.**

| What | Why |
|---|---|
| `SYLKEN_BACKUP_KEY` | decrypts every backup |
| `SYLKEN_DATA_KEY` | opens fields sylken encrypts inside the database |
| The PostgreSQL `postgres` password | a new computer needs one; it can be a new one |

The database passwords in `.env` can be replaced on a new computer; the two keys cannot.

## Restoring

A restore always goes into a **new** database, never over the live one, so a mistake cannot make things worse.

```
npm run restore -- --to sylken_restored                       (the newest backup)
npm run restore -- --to sylken_restored --file C:\path\sylken-20261011-220000.dump.enc
```

Then point `DATABASE_URL` and `DATABASE_ADMIN_URL` in `.env` at `sylken_restored` and restart sylken. Check it (items, patients, a recent sale), and keep the old database until you are sure.

### On a new computer

1. Install PostgreSQL 16 and Node 22, and get the sylken code.
2. Copy `.env.example` to `.env`; set the new database passwords, and put back `SYLKEN_BACKUP_KEY` and `SYLKEN_DATA_KEY` from your safe copy.
3. Copy the backup file (from the second copy) to the new computer's backup folder.
4. `npm install`, then restore as above, then `npm run migrate` (it brings the restored database up to this version).
5. Start sylken, and set up the nightly backup again.

## The restore test

`npm run backup:verify` restores the newest backup into a temporary database, counts the rows in the main tables (items, patients, scripts, sales, stock movements, runs, Z-reports and the audit log), compares them with the counts taken when the backup was made, and removes the temporary database. Run it after changing anything about backups, and from time to time. A backup you have not restored is a hope, not a backup.

## What is not in a backup

- `.env` (it holds passwords and keys), so keep your own copy of the two keys.
- sylken's program files; they come from the code.
- Anything outside the database: the Compharm export files you imported from, your label printer settings, the browser's saved till data (a till that was offline keeps its unsent sales in the browser until it connects).
