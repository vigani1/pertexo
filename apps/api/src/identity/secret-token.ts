import { SECRET_TOKEN_BYTES } from '@pertexo/contracts';
import { randomBytes } from 'node:crypto';

/** A fresh URL-safe secret token. */
export function randomSecretToken(): string {
  return randomBytes(SECRET_TOKEN_BYTES).toString('base64url');
}
