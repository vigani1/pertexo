import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import {
  DATA_KEY_BYTES,
  GCM_NONCE_BYTES,
  GCM_TAG_BYTES,
  MAX_ENCRYPTED_DATA_KEY_BYTES,
  type EncodedEnvelope,
  type FailureFactory,
  fail,
  assertNotAborted,
  boundedBytes,
  validKeyReference,
  encode,
  decode,
} from './envelope-format.js';
import type { EnvelopeKeyProviderCore } from './key-provider.js';

export {
  encodedEnvelopeSchemaFields,
  type EncodedEnvelope,
  isValidEnvelopeKeyReference,
} from './envelope-format.js';
export {
  type EnvelopeKeyMaterial,
  type EnvelopeKeyProviderCore,
  type KmsCommandLike,
  type KmsSendLike,
  AwsKmsEnvelopeKeyProviderCore,
} from './key-provider.js';
export class EnvelopeCipher<Context> {
  public constructor(
    private readonly keys: EnvelopeKeyProviderCore<Context>,
    private readonly options: Readonly<{
      associatedData(context: Context): Uint8Array;
      createFailure: FailureFactory;
      maximumPlaintextBytes: number;
      exactPlaintextBytes?: number;
      clearCallerPlaintext?: boolean;
    }>,
  ) {}

  public async seal(
    plaintext: Uint8Array,
    context: Context,
    signal?: AbortSignal,
  ): Promise<EncodedEnvelope> {
    let ownedPlaintext: Uint8Array | undefined;
    let providerKey: Uint8Array | undefined;
    let key: Uint8Array | undefined;
    let providerEncryptedDataKey: Uint8Array | undefined;
    let encryptedDataKey: Uint8Array | undefined;
    let nonce: Buffer | undefined;
    let authTag: Buffer | undefined;
    let cipherUpdate: Buffer | undefined;
    let cipherFinal: Buffer | undefined;
    let ciphertext: Buffer | undefined;
    try {
      assertNotAborted(signal, this.options.createFailure);
      const requiredBytes = this.options.exactPlaintextBytes ?? 1;
      ownedPlaintext = boundedBytes(
        plaintext,
        requiredBytes,
        this.options.exactPlaintextBytes ?? this.options.maximumPlaintextBytes,
        this.options.createFailure,
      );
      const generated = await this.keys.generateDataKey(context, signal);
      providerKey = generated.plaintextKey;
      assertNotAborted(signal, this.options.createFailure);
      key = boundedBytes(
        providerKey,
        DATA_KEY_BYTES,
        DATA_KEY_BYTES,
        this.options.createFailure,
      );
      providerKey.fill(0);
      providerEncryptedDataKey = generated.encryptedDataKey;
      encryptedDataKey = boundedBytes(
        providerEncryptedDataKey,
        1,
        MAX_ENCRYPTED_DATA_KEY_BYTES,
        this.options.createFailure,
      );
      providerEncryptedDataKey.fill(0);
      const keyReference = validKeyReference(
        generated.keyReference,
        this.options.createFailure,
      );
      nonce = randomBytes(GCM_NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(this.options.associatedData(context));
      cipherUpdate = cipher.update(ownedPlaintext);
      cipherFinal = cipher.final();
      ciphertext = Buffer.concat([cipherUpdate, cipherFinal]);
      authTag = cipher.getAuthTag();
      assertNotAborted(signal, this.options.createFailure);
      if (authTag.byteLength !== GCM_TAG_BYTES)
        fail(this.options.createFailure);
      return Object.freeze({
        keyReference,
        encryptedDataKey: encode(encryptedDataKey),
        ciphertext: encode(ciphertext),
        nonce: encode(nonce),
        authTag: encode(authTag),
      });
    } catch {
      throw this.options.createFailure();
    } finally {
      if (this.options.clearCallerPlaintext ?? false) plaintext.fill(0);
      ownedPlaintext?.fill(0);
      authTag?.fill(0);
      nonce?.fill(0);
      encryptedDataKey?.fill(0);
      providerEncryptedDataKey?.fill(0);
      ciphertext?.fill(0);
      cipherFinal?.fill(0);
      cipherUpdate?.fill(0);
      key?.fill(0);
      providerKey?.fill(0);
    }
  }

  public async open(
    envelope: EncodedEnvelope,
    context: Context,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    let providerKey: Uint8Array | undefined;
    let key: Uint8Array | undefined;
    let result: Uint8Array | undefined;
    let plaintext: Buffer | undefined;
    let decipherUpdate: Buffer | undefined;
    let decipherFinal: Buffer | undefined;
    let encryptedDataKey: Uint8Array | undefined;
    let nonce: Uint8Array | undefined;
    let authTag: Uint8Array | undefined;
    let ciphertext: Uint8Array | undefined;
    try {
      assertNotAborted(signal, this.options.createFailure);
      encryptedDataKey = decode(
        envelope.encryptedDataKey,
        1,
        MAX_ENCRYPTED_DATA_KEY_BYTES,
        this.options.createFailure,
      );
      const keyReference = validKeyReference(
        envelope.keyReference,
        this.options.createFailure,
      );
      nonce = decode(
        envelope.nonce,
        GCM_NONCE_BYTES,
        GCM_NONCE_BYTES,
        this.options.createFailure,
      );
      authTag = decode(
        envelope.authTag,
        GCM_TAG_BYTES,
        GCM_TAG_BYTES,
        this.options.createFailure,
      );
      const requiredBytes = this.options.exactPlaintextBytes ?? 1;
      ciphertext = decode(
        envelope.ciphertext,
        requiredBytes,
        this.options.exactPlaintextBytes ?? this.options.maximumPlaintextBytes,
        this.options.createFailure,
      );
      providerKey = await this.keys.decryptDataKey(
        encryptedDataKey,
        keyReference,
        context,
        signal,
      );
      assertNotAborted(signal, this.options.createFailure);
      key = boundedBytes(
        providerKey,
        DATA_KEY_BYTES,
        DATA_KEY_BYTES,
        this.options.createFailure,
      );
      providerKey.fill(0);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(this.options.associatedData(context));
      decipher.setAuthTag(authTag);
      decipherUpdate = decipher.update(ciphertext);
      decipherFinal = decipher.final();
      plaintext = Buffer.concat([decipherUpdate, decipherFinal]);
      if (
        plaintext.byteLength < requiredBytes ||
        plaintext.byteLength >
          (this.options.exactPlaintextBytes ??
            this.options.maximumPlaintextBytes)
      )
        fail(this.options.createFailure);
      result = new Uint8Array(plaintext);
      plaintext.fill(0);
      assertNotAborted(signal, this.options.createFailure);
      return result;
    } catch {
      result?.fill(0);
      throw this.options.createFailure();
    } finally {
      plaintext?.fill(0);
      decipherFinal?.fill(0);
      decipherUpdate?.fill(0);
      ciphertext?.fill(0);
      authTag?.fill(0);
      nonce?.fill(0);
      encryptedDataKey?.fill(0);
      key?.fill(0);
      providerKey?.fill(0);
    }
  }
}
