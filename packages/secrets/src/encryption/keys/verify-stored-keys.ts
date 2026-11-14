import { StoredKeyVerificationError } from '../encryption.errors.js';
import { connectionSecretAssociatedData } from '../envelopes/envelope-encryption.js';
import { webhookTriggerSecretAssociatedData } from '../envelopes/webhook-envelope.js';
import {
  SelfManagedEnvelopeKeyProvider,
  isSelfManagedKeyReference,
} from './self-managed-key-provider.js';
import type { ConnectionEnvelopeEncryptionConfig } from '../connection-encryption-config.js';

import type { StoredEncryptionKey } from './stored-encryption-key.types.js';
/** Connection-purpose keys include saved form links, bound to their workflow context. */
export async function verifyStoredEncryptionKeys(
  config: ConnectionEnvelopeEncryptionConfig,
  records: AsyncIterable<StoredEncryptionKey>,
  signal: AbortSignal,
): Promise<Readonly<{ connectionKeys: number; webhookKeys: number }>> {
  const fail = (): StoredKeyVerificationError =>
    new StoredKeyVerificationError('unavailable_key_material');
  const providers =
    'mode' in config
      ? {
          connection: new SelfManagedEnvelopeKeyProvider(
            config.encryption,
            connectionSecretAssociatedData,
            fail,
          ),
          webhook: new SelfManagedEnvelopeKeyProvider(
            config.encryption,
            webhookTriggerSecretAssociatedData,
            fail,
          ),
        }
      : undefined;
  let connectionKeys = 0;
  let webhookKeys = 0;
  try {
    signal.throwIfAborted();
    for await (const record of records) {
      signal.throwIfAborted();
      const selfManaged = isSelfManagedKeyReference(record.keyReference);
      if (selfManaged !== (providers !== undefined))
        throw new StoredKeyVerificationError('incompatible_provider');
      if (providers !== undefined) {
        const wrapped = Buffer.from(record.encryptedDataKey, 'base64url');
        let plaintext: Uint8Array | undefined;
        try {
          plaintext =
            record.kind === 'connection'
              ? await providers.connection.decryptDataKey(
                  wrapped,
                  record.keyReference,
                  {
                    workspaceId: record.workspaceId,
                    connectionId: record.resourceId,
                    secretVersionId: record.secretVersionId,
                  },
                  signal,
                )
              : await providers.webhook.decryptDataKey(
                  wrapped,
                  record.keyReference,
                  {
                    workspaceId: record.workspaceId,
                    triggerId: record.resourceId,
                    secretVersionId: record.secretVersionId,
                  },
                  signal,
                );
        } finally {
          plaintext?.fill(0);
          wrapped.fill(0);
        }
      }
      if (record.kind === 'connection') connectionKeys += 1;
      else webhookKeys += 1;
    }
    signal.throwIfAborted();
    return Object.freeze({ connectionKeys, webhookKeys });
  } catch (error: unknown) {
    if (signal.aborted) throw new StoredKeyVerificationError('cancelled');
    if (error instanceof StoredKeyVerificationError) throw error;
    throw new StoredKeyVerificationError('inventory_unavailable');
  }
}
