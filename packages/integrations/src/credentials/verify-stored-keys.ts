import { connectionSecretAssociatedData } from './envelope-encryption.js';
import { webhookTriggerSecretAssociatedData } from '../webhooks/crypto.js';
import {
  SelfManagedEnvelopeKeyProvider,
  isSelfManagedKeyReference,
} from './self-managed-key-provider.js';
import type { ConnectionEnvelopeEncryptionConfig } from './runtime.js';

export type StoredEncryptionKey = Readonly<{
  kind: 'connection' | 'webhook';
  workspaceId: string;
  resourceId: string;
  secretVersionId: string;
  keyReference: string;
  encryptedDataKey: string;
}>;
type VerificationFailure =
  | 'incompatible_provider'
  | 'unavailable_key_material'
  | 'inventory_unavailable'
  | 'cancelled';
export class StoredKeyVerificationError extends Error {
  public override readonly name = 'StoredKeyVerificationError';
  public constructor(public readonly code: VerificationFailure) {
    super(
      {
        incompatible_provider:
          'Stored secrets use a different encryption provider; provider migration is not supported',
        unavailable_key_material:
          'A stored encryption key is unavailable or damaged; check current and previous master keys',
        inventory_unavailable: 'Stored encryption key inventory is unavailable',
        cancelled: 'Stored encryption key verification was cancelled',
      }[code],
    );
  }
}

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
