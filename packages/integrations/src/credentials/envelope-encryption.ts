import {
  DecryptCommand,
  GenerateDataKeyCommand,
  type KMSClient,
} from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

const DATA_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 65_536;
const MAX_ENCRYPTED_DATA_KEY_BYTES = 8_192;
const MAX_KEY_REFERENCE_BYTES = 2_048;

const contextSchema = z
  .object({
    workspaceId: z.uuid(),
    connectionId: z.uuid(),
    secretVersionId: z.uuid(),
  })
  .strict();

const sealedSchema = z
  .object({
    schemaVersion: z.literal(1),
    kmsKeyReference: z.string().min(1).max(MAX_KEY_REFERENCE_BYTES),
    encryptedDataKey: z.string().min(1),
    ciphertext: z.string(),
    nonce: z.string().min(1),
    tag: z.string().min(1),
  })
  .strict();

export type ConnectionSecretContext = Readonly<z.output<typeof contextSchema>>;

export type SealedConnectionSecret = Readonly<z.output<typeof sealedSchema>>;

export type GeneratedEnvelopeKey = Readonly<{
  plaintextKey: Uint8Array;
  encryptedDataKey: Uint8Array;
  keyReference: string;
}>;

export interface EnvelopeKeyProvider {
  generateDataKey(
    context: ConnectionSecretContext,
    signal?: AbortSignal,
  ): Promise<GeneratedEnvelopeKey>;
  decryptDataKey(
    encryptedDataKey: Uint8Array,
    keyReference: string,
    context: ConnectionSecretContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

export type KmsCommand = GenerateDataKeyCommand | DecryptCommand;

export interface KmsClientLike {
  send(
    command: KmsCommand,
    options?: Readonly<{ abortSignal?: AbortSignal }>,
  ): Promise<unknown>;
}

export class ConnectionSecretEncryptionError extends Error {
  public override readonly name = 'ConnectionSecretEncryptionError';

  public constructor() {
    super('Connection secret encryption failed');
  }
}

function fail(cause?: unknown): never {
  void cause;
  throw new ConnectionSecretEncryptionError();
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) fail(signal.reason);
}

function kmsOptions(
  signal?: AbortSignal,
): Readonly<{ abortSignal?: AbortSignal }> | undefined {
  return signal === undefined ? undefined : { abortSignal: signal };
}

function kmsEncryptionContext(
  context: ConnectionSecretContext,
): Readonly<Record<string, string>> {
  return Object.freeze({
    purpose: 'pertexo-connection-secret',
    schemaVersion: '1',
    workspaceId: context.workspaceId,
    connectionId: context.connectionId,
    secretVersionId: context.secretVersionId,
  });
}

export function connectionSecretAssociatedData(
  context: ConnectionSecretContext,
): Uint8Array {
  const parsed = contextSchema.parse(context);
  return new TextEncoder().encode(
    [
      'pertexo:connection-secret:v1',
      parsed.workspaceId,
      parsed.connectionId,
      parsed.secretVersionId,
    ].join('\u0000'),
  );
}

function boundedBytes(value: unknown, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) fail();
  if (value.byteLength > maximum) fail();
  return new Uint8Array(value);
}

function decode(value: string, maximum: number, allowEmpty = false): Buffer {
  if ((!allowEmpty && value.length === 0) || !/^[A-Za-z0-9_-]*$/u.test(value))
    fail();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength > maximum || decoded.toString('base64url') !== value)
    fail();
  return decoded;
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function responseRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object') fail();
  return value as Readonly<Record<string, unknown>>;
}

export class AwsKmsEnvelopeKeyProvider implements EnvelopeKeyProvider {
  public constructor(
    private readonly client: Pick<KMSClient, 'send'> | KmsClientLike,
    private readonly keyReference: string,
  ) {
    if (
      keyReference.length === 0 ||
      Buffer.byteLength(keyReference, 'utf8') > MAX_KEY_REFERENCE_BYTES
    )
      throw new TypeError('KMS key reference is invalid');
  }

  public async generateDataKey(
    context: ConnectionSecretContext,
    signal?: AbortSignal,
  ): Promise<GeneratedEnvelopeKey> {
    const parsed = contextSchema.parse(context);
    let plaintextKey: Uint8Array | undefined;
    let providerPlaintextKey: Uint8Array | undefined;
    try {
      assertNotAborted(signal);
      const response = responseRecord(
        await this.client.send(
          new GenerateDataKeyCommand({
            KeyId: this.keyReference,
            KeySpec: 'AES_256',
            EncryptionContext: kmsEncryptionContext(parsed),
          }),
          kmsOptions(signal),
        ),
      );
      providerPlaintextKey =
        response.Plaintext instanceof Uint8Array
          ? response.Plaintext
          : undefined;
      plaintextKey = boundedBytes(response.Plaintext, DATA_KEY_BYTES);
      providerPlaintextKey?.fill(0);
      assertNotAborted(signal);
      if (plaintextKey.byteLength !== DATA_KEY_BYTES) fail();
      const encryptedDataKey = boundedBytes(
        response.CiphertextBlob,
        MAX_ENCRYPTED_DATA_KEY_BYTES,
      );
      const returnedReference = response.KeyId;
      if (
        returnedReference !== undefined &&
        (typeof returnedReference !== 'string' ||
          returnedReference.length === 0)
      )
        fail();
      return Object.freeze({
        plaintextKey,
        encryptedDataKey,
        keyReference:
          typeof returnedReference === 'string'
            ? returnedReference
            : this.keyReference,
      });
    } catch (error: unknown) {
      providerPlaintextKey?.fill(0);
      plaintextKey?.fill(0);
      throw error instanceof ConnectionSecretEncryptionError
        ? error
        : new ConnectionSecretEncryptionError();
    }
  }

  public async decryptDataKey(
    encryptedDataKey: Uint8Array,
    keyReference: string,
    context: ConnectionSecretContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const parsed = contextSchema.parse(context);
    const boundedEncryptedKey = boundedBytes(
      encryptedDataKey,
      MAX_ENCRYPTED_DATA_KEY_BYTES,
    );
    if (
      keyReference.length === 0 ||
      Buffer.byteLength(keyReference, 'utf8') > MAX_KEY_REFERENCE_BYTES
    )
      fail();
    let plaintextKey: Uint8Array | undefined;
    let providerPlaintextKey: Uint8Array | undefined;
    try {
      assertNotAborted(signal);
      const response = responseRecord(
        await this.client.send(
          new DecryptCommand({
            CiphertextBlob: boundedEncryptedKey,
            KeyId: keyReference,
            EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
            EncryptionContext: kmsEncryptionContext(parsed),
          }),
          kmsOptions(signal),
        ),
      );
      providerPlaintextKey =
        response.Plaintext instanceof Uint8Array
          ? response.Plaintext
          : undefined;
      plaintextKey = boundedBytes(response.Plaintext, DATA_KEY_BYTES);
      providerPlaintextKey?.fill(0);
      assertNotAborted(signal);
      if (plaintextKey.byteLength !== DATA_KEY_BYTES) fail();
      return plaintextKey;
    } catch (error: unknown) {
      providerPlaintextKey?.fill(0);
      plaintextKey?.fill(0);
      throw error instanceof ConnectionSecretEncryptionError
        ? error
        : new ConnectionSecretEncryptionError();
    }
  }
}

export class ConnectionEnvelopeEncryption {
  public constructor(private readonly keys: EnvelopeKeyProvider) {}

  public async seal(
    plaintext: Uint8Array,
    context: ConnectionSecretContext,
    signal?: AbortSignal,
  ): Promise<SealedConnectionSecret> {
    const parsedContext = contextSchema.parse(context);
    const boundedPlaintext = boundedBytes(plaintext, MAX_PLAINTEXT_BYTES);
    let plaintextKey: Uint8Array | undefined;
    let providerPlaintextKey: Uint8Array | undefined;
    try {
      assertNotAborted(signal);
      const generated = await this.keys.generateDataKey(parsedContext, signal);
      providerPlaintextKey = generated.plaintextKey;
      assertNotAborted(signal);
      plaintextKey = boundedBytes(providerPlaintextKey, DATA_KEY_BYTES);
      if (plaintextKey.byteLength !== DATA_KEY_BYTES) fail();
      const encryptedDataKey = boundedBytes(
        generated.encryptedDataKey,
        MAX_ENCRYPTED_DATA_KEY_BYTES,
      );
      if (
        generated.keyReference.length === 0 ||
        Buffer.byteLength(generated.keyReference, 'utf8') >
          MAX_KEY_REFERENCE_BYTES
      )
        fail();
      const nonce = randomBytes(GCM_NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', plaintextKey, nonce);
      cipher.setAAD(connectionSecretAssociatedData(parsedContext));
      const ciphertext = Buffer.concat([
        cipher.update(boundedPlaintext),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      assertNotAborted(signal);
      if (tag.byteLength !== GCM_TAG_BYTES) fail();
      return sealedSchema.parse({
        schemaVersion: 1,
        kmsKeyReference: generated.keyReference,
        encryptedDataKey: encode(encryptedDataKey),
        ciphertext: encode(ciphertext),
        nonce: encode(nonce),
        tag: encode(tag),
      });
    } catch (error: unknown) {
      throw error instanceof ConnectionSecretEncryptionError
        ? error
        : new ConnectionSecretEncryptionError();
    } finally {
      boundedPlaintext.fill(0);
      plaintextKey?.fill(0);
      providerPlaintextKey?.fill(0);
    }
  }

  public async open(
    sealed: SealedConnectionSecret,
    context: ConnectionSecretContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    let plaintextKey: Uint8Array | undefined;
    let providerPlaintextKey: Uint8Array | undefined;
    let result: Uint8Array | undefined;
    try {
      assertNotAborted(signal);
      const parsedSealed = sealedSchema.parse(sealed);
      const parsedContext = contextSchema.parse(context);
      const encryptedDataKey = decode(
        parsedSealed.encryptedDataKey,
        MAX_ENCRYPTED_DATA_KEY_BYTES,
      );
      providerPlaintextKey = await this.keys.decryptDataKey(
        encryptedDataKey,
        parsedSealed.kmsKeyReference,
        parsedContext,
        signal,
      );
      assertNotAborted(signal);
      plaintextKey = boundedBytes(providerPlaintextKey, DATA_KEY_BYTES);
      if (plaintextKey.byteLength !== DATA_KEY_BYTES) fail();
      const nonce = decode(parsedSealed.nonce, GCM_NONCE_BYTES);
      const tag = decode(parsedSealed.tag, GCM_TAG_BYTES);
      const ciphertext = decode(
        parsedSealed.ciphertext,
        MAX_PLAINTEXT_BYTES,
        true,
      );
      if (
        nonce.byteLength !== GCM_NONCE_BYTES ||
        tag.byteLength !== GCM_TAG_BYTES
      )
        fail();
      const decipher = createDecipheriv('aes-256-gcm', plaintextKey, nonce);
      decipher.setAAD(connectionSecretAssociatedData(parsedContext));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      if (
        plaintext.byteLength === 0 ||
        plaintext.byteLength > MAX_PLAINTEXT_BYTES
      )
        fail();
      result = new Uint8Array(plaintext);
      plaintext.fill(0);
      assertNotAborted(signal);
      return result;
    } catch (error: unknown) {
      throw error instanceof ConnectionSecretEncryptionError
        ? error
        : new ConnectionSecretEncryptionError();
    } finally {
      if (signal?.aborted === true) result?.fill(0);
      plaintextKey?.fill(0);
      providerPlaintextKey?.fill(0);
    }
  }
}
