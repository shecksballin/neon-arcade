// ─────────────────────────────────────────
// PROFILE — account registration rules
// ─────────────────────────────────────────
// Shared by the AccountSetup UI (client-side hints) and the Hono
// profile routes (authoritative Zod validation), so the two can never
// drift: what the form accepts is exactly what the server accepts.

/** 3–20 chars, letters/digits/underscore. Uniqueness is enforced
 *  case-insensitively by the database (lower(username) unique index). */
export const USERNAME_REGEX = /^[A-Za-z0-9_]{3,20}$/
export const USERNAME_RULES = '3–20 characters · letters, numbers, underscore'

/** The account PIN is exactly 4 digits. */
export const PIN_REGEX = /^\d{4}$/

/** Standard 6-digit TOTP code from an authenticator app. */
export const TOTP_CODE_REGEX = /^\d{6}$/

/** Issuer shown inside authenticator apps next to the account entry. */
export const TOTP_ISSUER = 'Neon Arcade'
