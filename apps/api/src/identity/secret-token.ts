import { randomBytes } from 'node:crypto';

/** A bearer token's or a key's random bytes: 256 bits, so it can't be guessed. */
export const SECRET_TOKEN_BYTES = 32;

/** A fresh URL-safe secret token. */
export function randomSecretToken(): string {
  return randomBytes(SECRET_TOKEN_BYTES).toString('base64url');
}
