import {
  createAwsConnectionEnvelopeEncryption,
  type AwsConnectionEnvelopeEncryptionRuntime,
} from './aws-envelope.runtime.js';
import {
  ConnectionEnvelopeEncryption,
  connectionSecretAssociatedData,
} from './envelopes/envelope-encryption.js';
import { ConnectionSecretEncryptionError } from './encryption.errors.js';
import { SelfManagedEnvelopeKeyProvider } from './keys/self-managed-key-provider.js';
import type { ConnectionEnvelopeEncryptionConfig } from './connection-encryption-config.js';

export type ConnectionEnvelopeEncryptionRuntime =
  AwsConnectionEnvelopeEncryptionRuntime;

export function createConnectionEnvelopeEncryption(
  config: ConnectionEnvelopeEncryptionConfig,
): ConnectionEnvelopeEncryptionRuntime {
  if (!('mode' in config)) return createAwsConnectionEnvelopeEncryption(config);
  return Object.freeze({
    encryption: new ConnectionEnvelopeEncryption(
      new SelfManagedEnvelopeKeyProvider(
        config.encryption,
        connectionSecretAssociatedData,
        () => new ConnectionSecretEncryptionError(),
      ),
    ),
    close: (): void => {
      /* Self-managed wrapping owns no sockets or timers. */
    },
  });
}
