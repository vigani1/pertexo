import { DecryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';

import {
  DATA_KEY_BYTES,
  MAX_ENCRYPTED_DATA_KEY_BYTES,
  type FailureFactory,
  assertNotAborted,
  boundedBytes,
  validKeyReference,
  responseRecord,
} from './envelope-format.js';

export type EnvelopeKeyMaterial = Readonly<{
  plaintextKey: Uint8Array;
  encryptedDataKey: Uint8Array;
  keyReference: string;
}>;

export interface EnvelopeKeyProviderCore<Context> {
  generateDataKey(
    context: Context,
    signal?: AbortSignal,
  ): Promise<EnvelopeKeyMaterial>;
  decryptDataKey(
    encryptedDataKey: Uint8Array,
    keyReference: string,
    context: Context,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

export type KmsCommandLike = GenerateDataKeyCommand | DecryptCommand;

export interface KmsSendLike {
  send(
    command: KmsCommandLike,
    options?: Readonly<{ abortSignal?: AbortSignal }>,
  ): Promise<unknown>;
}

function kmsOptions(
  signal?: AbortSignal,
): Readonly<{ abortSignal?: AbortSignal }> | undefined {
  return signal === undefined ? undefined : { abortSignal: signal };
}

export class AwsKmsEnvelopeKeyProviderCore<
  Context,
> implements EnvelopeKeyProviderCore<Context> {
  private readonly keyReference: string;

  public constructor(
    private readonly client: KmsSendLike,
    keyReference: string,
    private readonly encryptionContext: (
      context: Context,
    ) => Readonly<Record<string, string>>,
    private readonly createFailure: FailureFactory,
  ) {
    this.keyReference = validKeyReference(
      keyReference,
      () => new TypeError('KMS key reference is invalid'),
    );
  }

  public async generateDataKey(
    context: Context,
    signal?: AbortSignal,
  ): Promise<EnvelopeKeyMaterial> {
    let providerPlaintext: Uint8Array | undefined;
    let plaintextKey: Uint8Array | undefined;
    try {
      assertNotAborted(signal, this.createFailure);
      const response = responseRecord(
        await this.client.send(
          new GenerateDataKeyCommand({
            KeyId: this.keyReference,
            KeySpec: 'AES_256',
            EncryptionContext: this.encryptionContext(context),
          }),
          kmsOptions(signal),
        ),
        this.createFailure,
      );
      providerPlaintext =
        response.Plaintext instanceof Uint8Array
          ? response.Plaintext
          : undefined;
      plaintextKey = boundedBytes(
        response.Plaintext,
        DATA_KEY_BYTES,
        DATA_KEY_BYTES,
        this.createFailure,
      );
      providerPlaintext?.fill(0);
      assertNotAborted(signal, this.createFailure);
      const encryptedDataKey = boundedBytes(
        response.CiphertextBlob,
        1,
        MAX_ENCRYPTED_DATA_KEY_BYTES,
        this.createFailure,
      );
      const returnedReference =
        response.KeyId === undefined
          ? this.keyReference
          : validKeyReference(response.KeyId, this.createFailure);
      return Object.freeze({
        plaintextKey,
        encryptedDataKey,
        keyReference: returnedReference,
      });
    } catch {
      providerPlaintext?.fill(0);
      plaintextKey?.fill(0);
      throw this.createFailure();
    }
  }

  public async decryptDataKey(
    encryptedDataKey: Uint8Array,
    keyReference: string,
    context: Context,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const boundedEncryptedKey = boundedBytes(
      encryptedDataKey,
      1,
      MAX_ENCRYPTED_DATA_KEY_BYTES,
      this.createFailure,
    );
    const boundedReference = validKeyReference(
      keyReference,
      this.createFailure,
    );
    let providerPlaintext: Uint8Array | undefined;
    let plaintextKey: Uint8Array | undefined;
    try {
      assertNotAborted(signal, this.createFailure);
      const response = responseRecord(
        await this.client.send(
          new DecryptCommand({
            CiphertextBlob: boundedEncryptedKey,
            KeyId: boundedReference,
            EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
            EncryptionContext: this.encryptionContext(context),
          }),
          kmsOptions(signal),
        ),
        this.createFailure,
      );
      providerPlaintext =
        response.Plaintext instanceof Uint8Array
          ? response.Plaintext
          : undefined;
      plaintextKey = boundedBytes(
        response.Plaintext,
        DATA_KEY_BYTES,
        DATA_KEY_BYTES,
        this.createFailure,
      );
      providerPlaintext?.fill(0);
      assertNotAborted(signal, this.createFailure);
      return plaintextKey;
    } catch {
      providerPlaintext?.fill(0);
      plaintextKey?.fill(0);
      throw this.createFailure();
    } finally {
      boundedEncryptedKey.fill(0);
    }
  }
}
