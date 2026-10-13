import { randomBytes } from 'node:crypto';
import type { ApplicationKeyRing } from '../security/key-ring.js';
import { createApplicationSecretEnvelope } from '../security/application-secret-envelope.js';
import type {
  EnvelopeKeyProviderCore,
  EnvelopeKeyMaterial,
} from '../crypto/envelope-cipher.js';

const KEY_REFERENCE = 'self-managed';
const LEGACY_REFERENCE = 'local:development';

export function isSelfManagedKeyReference(reference: string): boolean {
  return reference === KEY_REFERENCE || reference === LEGACY_REFERENCE;
}

/** Wraps data keys locally; the deployment gate belongs to startup configuration. */
export class SelfManagedEnvelopeKeyProvider<
  Context,
> implements EnvelopeKeyProviderCore<Context> {
  private readonly envelope;

  public constructor(
    encryption: ApplicationKeyRing,
    private readonly associatedData: (context: Context) => Uint8Array,
    private readonly failure: () => Error,
  ) {
    this.envelope = createApplicationSecretEnvelope(encryption);
  }

  public generateDataKey(
    context: Context,
    signal?: AbortSignal,
  ): Promise<EnvelopeKeyMaterial> {
    signal?.throwIfAborted();
    const plaintextKey = randomBytes(32);
    try {
      const sealed = this.envelope.seal(
        plaintextKey.toString('base64url'),
        Buffer.from(this.associatedData(context)).toString('utf8'),
      );
      return Promise.resolve({
        plaintextKey,
        encryptedDataKey: Buffer.from(JSON.stringify(sealed), 'utf8'),
        keyReference: KEY_REFERENCE,
      });
    } catch {
      plaintextKey.fill(0);
      throw this.failure();
    }
  }

  public decryptDataKey(
    encryptedDataKey: Uint8Array,
    keyReference: string,
    context: Context,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    try {
      if (
        !isSelfManagedKeyReference(keyReference) ||
        encryptedDataKey.byteLength > 1_024
      )
        throw this.failure();
      const sealed: unknown = JSON.parse(
        Buffer.from(encryptedDataKey).toString('utf8'),
      );
      if (
        keyReference === LEGACY_REFERENCE &&
        (typeof sealed !== 'object' ||
          sealed === null ||
          !('keyVersion' in sealed) ||
          sealed.keyVersion !== LEGACY_REFERENCE)
      )
        throw this.failure();
      // The envelope validates its opaque stored representation at this boundary.
      const encoded = this.envelope.open(
        sealed,
        Buffer.from(this.associatedData(context)).toString('utf8'),
      );
      const key = Buffer.from(encoded, 'base64url');
      if (key.byteLength !== 32 || key.toString('base64url') !== encoded) {
        key.fill(0);
        throw this.failure();
      }
      return Promise.resolve(key);
    } catch {
      throw this.failure();
    }
  }
}
