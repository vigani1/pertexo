import { DecryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

const DATA_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_ENCRYPTED_DATA_KEY_BYTES = 8_192;
const MAX_KEY_REFERENCE_BYTES = 2_048;

export const encodedEnvelopeSchemaFields = Object.freeze({
  schemaVersion: z.literal(1),
  kmsKeyReference: z.string().min(1).max(MAX_KEY_REFERENCE_BYTES),
  encryptedDataKey: z.string().min(1),
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
});

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

export type EncodedEnvelope = Readonly<{
  keyReference: string;
  encryptedDataKey: string;
  ciphertext: string;
  nonce: string;
  authTag: string;
}>;

export type KmsCommandLike = GenerateDataKeyCommand | DecryptCommand;

export interface KmsSendLike {
  send(
    command: KmsCommandLike,
    options?: Readonly<{ abortSignal?: AbortSignal }>,
  ): Promise<unknown>;
}

type FailureFactory = () => Error;

function fail(createFailure: FailureFactory): never {
  throw createFailure();
}

function assertNotAborted(
  signal: AbortSignal | undefined,
  createFailure: FailureFactory,
): void {
  if (signal?.aborted === true) fail(createFailure);
}

function boundedBytes(
  value: unknown,
  minimum: number,
  maximum: number,
  createFailure: FailureFactory,
): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < minimum ||
    value.byteLength > maximum
  )
    fail(createFailure);
  return new Uint8Array(value);
}

function validKeyReference(
  value: unknown,
  createFailure: FailureFactory,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_KEY_REFERENCE_BYTES
  )
    fail(createFailure);
  return value;
}

function responseRecord(
  value: unknown,
  createFailure: FailureFactory,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object') fail(createFailure);
  return value as Readonly<Record<string, unknown>>;
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function decode(
  value: string,
  minimum: number,
  maximum: number,
  createFailure: FailureFactory,
): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) fail(createFailure);
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.byteLength < minimum ||
    decoded.byteLength > maximum ||
    decoded.toString('base64url') !== value
  )
    fail(createFailure);
  return new Uint8Array(decoded);
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
    }
  }
}

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
      const encryptedDataKey = boundedBytes(
        generated.encryptedDataKey,
        1,
        MAX_ENCRYPTED_DATA_KEY_BYTES,
        this.options.createFailure,
      );
      const keyReference = validKeyReference(
        generated.keyReference,
        this.options.createFailure,
      );
      const nonce = randomBytes(GCM_NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(this.options.associatedData(context));
      const ciphertext = Buffer.concat([
        cipher.update(ownedPlaintext),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
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
      if (this.options.clearCallerPlaintext === true) plaintext.fill(0);
      ownedPlaintext?.fill(0);
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
    try {
      assertNotAborted(signal, this.options.createFailure);
      providerKey = await this.keys.decryptDataKey(
        decode(
          envelope.encryptedDataKey,
          1,
          MAX_ENCRYPTED_DATA_KEY_BYTES,
          this.options.createFailure,
        ),
        validKeyReference(envelope.keyReference, this.options.createFailure),
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
      const nonce = decode(
        envelope.nonce,
        GCM_NONCE_BYTES,
        GCM_NONCE_BYTES,
        this.options.createFailure,
      );
      const authTag = decode(
        envelope.authTag,
        GCM_TAG_BYTES,
        GCM_TAG_BYTES,
        this.options.createFailure,
      );
      const requiredBytes = this.options.exactPlaintextBytes ?? 1;
      const ciphertext = decode(
        envelope.ciphertext,
        requiredBytes,
        this.options.exactPlaintextBytes ?? this.options.maximumPlaintextBytes,
        this.options.createFailure,
      );
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(this.options.associatedData(context));
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
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
      key?.fill(0);
      providerKey?.fill(0);
    }
  }
}
