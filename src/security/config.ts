/**
 * Login and session limits. Kept in one place so a reviewer can see them at a glance; they
 * are not shop settings, because a pharmacy should not be able to weaken them.
 */
export const security = {
  /** A session ends after this long with no activity. */
  idleMinutes: 15,
  /** A session ends this long after login, active or not (one shift). */
  absoluteHours: 12,
  /** A login waiting for its second factor ends after this long. */
  pendingMinutes: 5,
  /** Wrong passwords or codes in a row before the account locks. */
  maxFailures: 5,
  /** How long a locked account stays locked (a manager can unlock it sooner). */
  lockMinutes: 15,
  /** Login attempts allowed from one IP address per window, whichever accounts they try. */
  ipAttempts: 20,
  ipWindowMinutes: 15,
  minPasswordLength: 10,
  recoveryCodes: 10,
} as const
