/**
 * TOTP SECRET ENCRYPTION (AES-256-GCM)
 * ====================================
 * TOTP secrets are symmetric: whoever reads one can mint valid codes
 * forever. So they never touch the database in plaintext — they are
 * sealed with AES-256-GCM under TOTP_ENC_KEY (32 bytes of hex, Doppler)
 * and stored as base64( iv | ciphertext | authTag ).
 *
 * GCM gives confidentiality AND integrity: a tampered row fails the
 * auth-tag check on decrypt instead of yielding garbage that validates
 * nothing. A fresh random 12-byte IV per encryption keeps identical
 * secrets from producing identical rows.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from '../config/env'

const IV_LENGTH = 12 // bytes — the GCM standard nonce size
const TAG_LENGTH = 16 // bytes — full-strength auth tag

function key(): Buffer {
  if (!config.TOTP_ENC_KEY) {
    // Callers gate on config.TOTP_ENC_KEY and 503 first; this throw is
    // the belt-and-braces path, never the user-facing error.
    throw new Error('TOTP_ENC_KEY is not configured')
  }
  return Buffer.from(config.TOTP_ENC_KEY, 'hex')
}

/** Seal a base32 TOTP secret for storage. */
export function encryptTotpSecret(secretBase32: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, ciphertext, tag]).toString('base64')
}

/** Open a sealed secret from the database. Throws if tampered. */
export function decryptTotpSecret(sealed: string): string {
  const raw = Buffer.from(sealed, 'base64')
  const iv = raw.subarray(0, IV_LENGTH)
  const ciphertext = raw.subarray(IV_LENGTH, raw.length - TAG_LENGTH)
  const tag = raw.subarray(raw.length - TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
