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
    const credential = definition.schema.parse(value);
    const { test } = definition;
    const auth =
      'resolve' in definition.auth
        ? definition.auth.resolve(credential)
        : definition.auth;
    if (test.kind === 'http') {
      const target =
        typeof test.target === 'string'
          ? { url: test.target, headers: undefined }
          : test.target.resolve(credential);
      return {
        credential,
        recipe: {
          ...test,
          target: target.url,
          ...(target.headers === undefined
            ? {}
            : { headers: { ...test.headers, ...target.headers } }),
        },
        auth,
      };
    }
    return {
      credential,
      recipe: test,
      auth,
    };
  } catch {
    throw new ConnectionSecretEncryptionError();
  }
}
