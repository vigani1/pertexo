import type { findConnectionDefinition } from '@pertexo/node-catalog';
import { ConnectionSecretEncryptionError } from '@pertexo/secrets/server';

export function decodeCredential(
  plaintext: Uint8Array,
  definition: NonNullable<ReturnType<typeof findConnectionDefinition>>,
) {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
    );
    return {
      credential: definition.schema.parse(value),
      recipe: definition.test,
      auth: definition.auth,
    };
  } catch {
    throw new ConnectionSecretEncryptionError();
  }
}
