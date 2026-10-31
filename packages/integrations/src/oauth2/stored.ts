import {
  oauth2ClientSettingsSchema,
  type OAuth2ClientSettings,
} from '@pertexo/contracts';
import { z } from 'zod';

import { ConnectionSecretEncryptionError } from '../credentials/envelope-encryption.js';

const storedTokensSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
  })
  .strict();

const storedCredentialSchema = z
  .object({ type: z.literal('oauth2'), clientSecret: z.string().min(1) })
  .strict();

export type OAuth2StoredTokens = z.output<typeof storedTokensSchema>;

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function decode<Output>(schema: z.ZodType<Output>, bytes: Uint8Array): Output {
  try {
    return schema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new ConnectionSecretEncryptionError();
  }
}

/** Names what is kept, so an `id_token` or anything else a service adds is never sealed. */
export function encodeStoredTokens(tokens: OAuth2StoredTokens): Uint8Array {
  return encode({
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken === undefined
      ? {}
      : { refreshToken: tokens.refreshToken }),
  });
}

export function decodeStoredTokens(bytes: Uint8Array): OAuth2StoredTokens {
  return decode(storedTokensSchema, bytes);
}

/** Settings live in their own row: only the secret is sealed. */
export function encodeStoredClientSecret(clientSecret: string): Uint8Array {
  return encode({ type: 'oauth2', clientSecret });
}

export function decodeStoredClientSecret(bytes: Uint8Array): string {
  return decode(storedCredentialSchema, bytes).clientSecret;
}

export function decodeClientSettings(value: unknown): OAuth2ClientSettings {
  return oauth2ClientSettingsSchema.parse(value);
}

/** Client credentials renews with a new request, so it needs no refresh token. */
export function isRenewable(
  settings: OAuth2ClientSettings,
  tokens: OAuth2StoredTokens,
): boolean {
  return (
    settings.grantType === 'client_credentials' ||
    tokens.refreshToken !== undefined
  );
}
