import { randomBytes } from 'node:crypto';
import { createApplicationSecretEnvelope } from '../security/application-secret-envelope.js';
import {
  connectionSecretAssociatedData,
  ConnectionSecretEncryptionError,
  type ConnectionSecretContext,
  type EnvelopeKeyProvider,
  type GeneratedEnvelopeKey,
} from './envelope-encryption.js';

const KEY_REFERENCE = 'local:development';

/** Wraps data keys locally; the deployment gate belongs to startup configuration. */
export class LocalEnvelopeKeyProvider implements EnvelopeKeyProvider {
  private readonly envelope;

  public constructor(key: string) {
    this.envelope = createApplicationSecretEnvelope({
      current: { version: KEY_REFERENCE, key },
    });
  }

  public generateDataKey(
    context: ConnectionSecretContext,
    signal?: AbortSignal,
  ): Promise<GeneratedEnvelopeKey> {
    signal?.throwIfAborted();
    const plaintextKey = randomBytes(32);
    try {
      const sealed = this.envelope.seal(
        plaintextKey.toString('base64url'),
        Buffer.from(connectionSecretAssociatedData(context)).toString('utf8'),
      );
      return Promise.resolve({
        plaintextKey,
        encryptedDataKey: Buffer.from(JSON.stringify(sealed), 'utf8'),
        keyReference: KEY_REFERENCE,
      });
    } catch {
      plaintextKey.fill(0);
      throw new ConnectionSecretEncryptionError();
    }
  }

  public decryptDataKey(
    encryptedDataKey: Uint8Array,
    keyReference: string,
    context: ConnectionSecretContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    try {
      if (keyReference !== KEY_REFERENCE || encryptedDataKey.byteLength > 1_024)
        throw new ConnectionSecretEncryptionError();
      const sealed: unknown = JSON.parse(
        Buffer.from(encryptedDataKey).toString('utf8'),
      );
      // The envelope validates its opaque stored representation at this boundary.
      const encoded = this.envelope.open(
        sealed,
        Buffer.from(connectionSecretAssociatedData(context)).toString('utf8'),
      );
      const key = Buffer.from(encoded, 'base64url');
      if (key.byteLength !== 32 || key.toString('base64url') !== encoded) {
        key.fill(0);
        throw new ConnectionSecretEncryptionError();
      }
      return Promise.resolve(key);
    } catch {
      throw new ConnectionSecretEncryptionError();
    }
  }
}
