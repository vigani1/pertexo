import { randomBytes } from 'node:crypto';

import type { ConnectionEnvelopeEncryption } from '@pertexo/integrations/server';
import type {
  ConnectionSecretContext,
  EnvelopeKeyProvider,
} from '@pertexo/integrations/server';

export class ContextKeyProvider implements EnvelopeKeyProvider {
  private readonly key = randomBytes(32);

  generateDataKey(context: ConnectionSecretContext) {
    return Promise.resolve({
      plaintextKey: new Uint8Array(this.key),
      encryptedDataKey: new TextEncoder().encode(JSON.stringify(context)),
      keyReference: 'integration-context-key',
    });
  }

  decryptDataKey(
    encryptedDataKey: Uint8Array,
    keyReference: string,
    context: ConnectionSecretContext,
  ) {
    if (
      keyReference !== 'integration-context-key' ||
      new TextDecoder().decode(encryptedDataKey) !== JSON.stringify(context)
    )
      throw new Error('encryption context mismatch');
    return Promise.resolve(new Uint8Array(this.key));
  }
}

export async function sealAndZero(
  encryption: ConnectionEnvelopeEncryption,
  plaintext: Uint8Array,
  context: ConnectionSecretContext,
) {
  try {
    return await encryption.seal(plaintext, context);
  } finally {
    plaintext.fill(0);
  }
}
