/**
 * AES-256-GCM encrypt / decrypt utility.
 *
 * Purpose:  Application-layer symmetric encryption for at-rest secrets that
 *           cannot be stored as plaintext even in a tenant-isolated row.
 *           First consumer is the Outlook OAuth flow (Prompt 08) —
 *           access_token + refresh_token columns on public.outlook_connections
 *           are written as ciphertext so a read-only DB dump, a leaked
 *           Supabase snapshot, or a rogue service-role query cannot hand
 *           attackers working Microsoft tokens. The key lives outside the
 *           database in OUTLOOK_TOKEN_ENCRYPTION_KEY so compromise of one
 *           (DB or secret store) is not sufficient to impersonate a user.
 *
 *           Algorithm: AES-256-GCM.
 *             - 256-bit key (32 raw bytes, hex-encoded in env)
 *             - 96-bit random IV per encryption (required; never reuse)
 *             - 128-bit auth tag verifies integrity on decrypt
 *
 *           Serialized format: `<iv>.<ciphertext>.<tag>` each base64url.
 *           Same dot-separated structure the rest of the codebase uses
 *           for stateless tokens (vendor-token.ts), so ops tooling can
 *           grep for "three dot-separated base64url segments" uniformly.
 *
 *           Failure policy: decrypt throws on any tampering, bad format,
 *           wrong key, or missing env. Callers must treat the exception
 *           as "row unusable" and fail closed — never log the ciphertext.
 *           encrypt throws if the key is missing or the wrong length.
 *
 *           This module is intentionally minimal: one encrypt, one decrypt,
 *           one env accessor. Do not add "sugar" wrappers here — the less
 *           surface, the less opportunity for misuse.
 *
 * Inputs:   process.env.OUTLOOK_TOKEN_ENCRYPTION_KEY — 32 bytes hex (64 chars).
 * Outputs:  encrypt(plaintext) → string, decrypt(blob) → string.
 * Agent/API: consumed by outlook.ts for access/refresh token storage.
 * Imports:  node:crypto (built-in, no new deps).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_ENV_VAR = 'OUTLOOK_TOKEN_ENCRYPTION_KEY';
const EXPECTED_KEY_BYTES = 32;
const IV_BYTES = 12;

function getEncryptionKey(): Buffer {
  const hex = process.env[KEY_ENV_VAR];
  if (!hex || hex.length === 0) {
    throw new Error(
      `LMBR.ai: missing ${KEY_ENV_VAR} environment variable. ` +
        'Set it in apps/web/.env.local — 32 random bytes encoded as hex ' +
        "(generate with `openssl rand -hex 32`). Required for Outlook " +
        'token storage; the Outlook integration cannot run without it.',
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(hex, 'hex');
  } catch {
    throw new Error(
      `LMBR.ai: ${KEY_ENV_VAR} is not valid hex. Expected ${EXPECTED_KEY_BYTES * 2} hex characters.`,
    );
  }
  if (key.length !== EXPECTED_KEY_BYTES) {
    throw new Error(
      `LMBR.ai: ${KEY_ENV_VAR} decodes to ${key.length} bytes; expected ${EXPECTED_KEY_BYTES}. ` +
        'Generate a fresh key with `openssl rand -hex 32`.',
    );
  }
  return key;
}

/**
 * Encrypt a UTF-8 string. Returns `<iv>.<ciphertext>.<tag>` base64url.
 * Throws if the key env var is missing or malformed.
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    iv.toString('base64url') +
    '.' +
    ciphertext.toString('base64url') +
    '.' +
    tag.toString('base64url')
  );
}

/**
 * Decrypt a blob produced by encrypt(). Throws on any failure — bad format,
 * wrong key, tampered ciphertext, truncated tag. Callers should catch and
 * treat the row as unusable; the token must not be relied on.
 */
export function decrypt(blob: string): string {
  if (typeof blob !== 'string' || blob.length === 0) {
    throw new Error('LMBR.ai decrypt: empty blob.');
  }
  const parts = blob.split('.');
  if (parts.length !== 3) {
    throw new Error('LMBR.ai decrypt: expected `<iv>.<ciphertext>.<tag>` format.');
  }
  // After the length check every entry is a string; assert for the type
  // narrowing that noUncheckedIndexedAccess would otherwise require.
  const ivB64 = parts[0] as string;
  const ctB64 = parts[1] as string;
  const tagB64 = parts[2] as string;
  const iv = Buffer.from(ivB64, 'base64url');
  const ciphertext = Buffer.from(ctB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  if (iv.length !== IV_BYTES) {
    throw new Error(`LMBR.ai decrypt: bad IV length (${iv.length}).`);
  }
  if (tag.length !== 16) {
    throw new Error(`LMBR.ai decrypt: bad auth tag length (${tag.length}).`);
  }

  const key = getEncryptionKey();
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
