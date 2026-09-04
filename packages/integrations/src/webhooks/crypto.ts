import {
  DecryptCommand,
  GenerateDataKeyCommand,
  type KMSClient,
} from '@aws-sdk/client-kms';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import { createBoundedKmsClient } from '../credentials/kms-client.js';

const contextSchema = z
  .object({
    workspaceId: z.uuid(),
    triggerId: z.uuid(),
    secretVersionId: z.uuid(),
  })
  .strict();
const sealedSchema = z
  .object({
    schemaVersion: z.literal(1),
    kmsKeyReference: z.string().min(1).max(2_048),
    encryptedDataKey: z.string().min(1),
    ciphertext: z.string().min(1),
    nonce: z.string().min(1),
    authTag: z.string().min(1),
  })
  .strict();

export type WebhookTriggerSecretContext = Readonly<
  z.output<typeof contextSchema>
>;
export type SealedWebhookTriggerSecretEnvelope = Readonly<
  z.output<typeof sealedSchema>
>;
export type GeneratedWebhookEnvelopeKey = Readonly<{
  plaintextKey: Uint8Array;
  encryptedDataKey: Uint8Array;
  keyReference: string;
}>;
export interface WebhookEnvelopeKeyProvider {
  generateDataKey(
    context: WebhookTriggerSecretContext,
    signal?: AbortSignal,
  ): Promise<GeneratedWebhookEnvelopeKey>;
  decryptDataKey(
    encryptedDataKey: Uint8Array,
    keyReference: string,
    context: WebhookTriggerSecretContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

export class WebhookTriggerSecretEncryptionError extends Error {
  public override readonly name = 'WebhookTriggerSecretEncryptionError';
  public constructor() {
    super('Webhook trigger secret encryption failed');
  }
}

function encryptionContext(context: WebhookTriggerSecretContext) {
  return {
    purpose: 'pertexo-webhook-trigger-secret',
    schemaVersion: '1',
    workspaceId: context.workspaceId,
    triggerId: context.triggerId,
    secretVersionId: context.secretVersionId,
  };
}

export function webhookTriggerSecretAssociatedData(
  context: WebhookTriggerSecretContext,
): Uint8Array {
  const parsed = contextSchema.parse(context);
  return new TextEncoder().encode(
    [
      'pertexo:webhook-trigger-secret:v1',
      parsed.workspaceId,
      parsed.triggerId,
      parsed.secretVersionId,
    ].join('\0'),
  );
}

function copyBytes(value: unknown, maximum: number): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > maximum
  )
    throw new WebhookTriggerSecretEncryptionError();
  return new Uint8Array(value);
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function decode(value: string, maximum: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value))
    throw new WebhookTriggerSecretEncryptionError();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.byteLength > maximum || bytes.toString('base64url') !== value)
    throw new WebhookTriggerSecretEncryptionError();
  return new Uint8Array(bytes);
}

export class AwsKmsWebhookEnvelopeKeyProvider implements WebhookEnvelopeKeyProvider {
  public constructor(
    private readonly client: Pick<KMSClient, 'send'>,
    private readonly keyReference: string,
  ) {
    if (keyReference.length < 1 || Buffer.byteLength(keyReference) > 2_048)
      throw new TypeError('KMS key reference is invalid');
  }

  public async generateDataKey(
    context: WebhookTriggerSecretContext,
    signal?: AbortSignal,
  ) {
    const parsed = contextSchema.parse(context);
    let providerPlaintext: Uint8Array | undefined;
    let plaintextKey: Uint8Array | undefined;
    try {
      const response = await this.client.send(
        new GenerateDataKeyCommand({
          KeyId: this.keyReference,
          KeySpec: 'AES_256',
          EncryptionContext: encryptionContext(parsed),
        }),
        signal === undefined ? undefined : { abortSignal: signal },
      );
      providerPlaintext = response.Plaintext;
      plaintextKey = copyBytes(providerPlaintext, 32);
      const encryptedDataKey = copyBytes(response.CiphertextBlob, 8_192);
      providerPlaintext?.fill(0);
      if (plaintextKey.byteLength !== 32)
        throw new WebhookTriggerSecretEncryptionError();
      return Object.freeze({
        plaintextKey,
        encryptedDataKey,
        keyReference: response.KeyId ?? this.keyReference,
      });
    } catch {
      providerPlaintext?.fill(0);
      plaintextKey?.fill(0);
      throw new WebhookTriggerSecretEncryptionError();
    }
  }

  public async decryptDataKey(
    encryptedDataKey: Uint8Array,
    keyReference: string,
    context: WebhookTriggerSecretContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    let providerPlaintext: Uint8Array | undefined;
    let result: Uint8Array | undefined;
    try {
      const response = await this.client.send(
        new DecryptCommand({
          CiphertextBlob: copyBytes(encryptedDataKey, 8_192),
          KeyId: keyReference,
          EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
          EncryptionContext: encryptionContext(contextSchema.parse(context)),
        }),
        signal === undefined ? undefined : { abortSignal: signal },
      );
      providerPlaintext = response.Plaintext;
      result = copyBytes(providerPlaintext, 32);
      providerPlaintext?.fill(0);
      if (result.byteLength !== 32)
        throw new WebhookTriggerSecretEncryptionError();
      return result;
    } catch {
      providerPlaintext?.fill(0);
      result?.fill(0);
      throw new WebhookTriggerSecretEncryptionError();
    }
  }
}

export function createAwsWebhookTriggerEnvelopeEncryption(
  config: Readonly<{
    keyReference: string;
    region: string;
    endpoint?: string;
  }>,
) {
  const client = createBoundedKmsClient(config);
  return Object.freeze({
    encryption: new WebhookTriggerEnvelopeEncryption(
      new AwsKmsWebhookEnvelopeKeyProvider(client, config.keyReference),
    ),
    close: () => {
      client.destroy();
    },
  });
}

export class WebhookTriggerEnvelopeEncryption {
  public constructor(private readonly keys: WebhookEnvelopeKeyProvider) {}

  public async seal(
    plaintext: Uint8Array,
    context: WebhookTriggerSecretContext,
    signal?: AbortSignal,
  ): Promise<SealedWebhookTriggerSecretEnvelope> {
    const parsed = contextSchema.parse(context);
    const secret = copyBytes(plaintext, 32);
    let key: Uint8Array | undefined;
    let providerKey: Uint8Array | undefined;
    try {
      if (secret.byteLength !== 32)
        throw new WebhookTriggerSecretEncryptionError();
      const generated = await this.keys.generateDataKey(parsed, signal);
      providerKey = generated.plaintextKey;
      key = copyBytes(providerKey, 32);
      providerKey.fill(0);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(webhookTriggerSecretAssociatedData(parsed));
      const ciphertext = cipher.update(secret);
      cipher.final();
      const authTag = cipher.getAuthTag();
      return sealedSchema.parse({
        schemaVersion: 1,
        kmsKeyReference: generated.keyReference,
        encryptedDataKey: encode(generated.encryptedDataKey),
        ciphertext: encode(ciphertext),
        nonce: encode(nonce),
        authTag: encode(authTag),
      });
    } catch (error) {
      if (error instanceof WebhookTriggerSecretEncryptionError) throw error;
      throw new WebhookTriggerSecretEncryptionError();
    } finally {
      plaintext.fill(0);
      secret.fill(0);
      key?.fill(0);
      providerKey?.fill(0);
    }
  }

  public async open(
    sealed: SealedWebhookTriggerSecretEnvelope,
    context: WebhookTriggerSecretContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    let key: Uint8Array | undefined;
    let providerKey: Uint8Array | undefined;
    let plaintextBuffer: Buffer | undefined;
    try {
      const parsed = sealedSchema.parse(sealed);
      const parsedContext = contextSchema.parse(context);
      providerKey = await this.keys.decryptDataKey(
        decode(parsed.encryptedDataKey, 8_192),
        parsed.kmsKeyReference,
        parsedContext,
        signal,
      );
      key = copyBytes(providerKey, 32);
      providerKey.fill(0);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        decode(parsed.nonce, 12),
      );
      decipher.setAAD(webhookTriggerSecretAssociatedData(parsedContext));
      decipher.setAuthTag(decode(parsed.authTag, 16));
      plaintextBuffer = decipher.update(decode(parsed.ciphertext, 32));
      decipher.final();
      if (plaintextBuffer.byteLength !== 32)
        throw new WebhookTriggerSecretEncryptionError();
      return new Uint8Array(plaintextBuffer);
    } catch (error) {
      if (error instanceof WebhookTriggerSecretEncryptionError) throw error;
      throw new WebhookTriggerSecretEncryptionError();
    } finally {
      plaintextBuffer?.fill(0);
      key?.fill(0);
      providerKey?.fill(0);
    }
  }
}

export function verifyWebhookSignature(
  input: Readonly<{
    secret: Uint8Array;
    timestamp: string;
    signature: string;
    rawBody: Uint8Array;
  }>,
): boolean {
  if (
    !/^v1=[0-9a-f]{64}$/u.test(input.signature) ||
    !/^\d{1,16}$/u.test(input.timestamp)
  )
    return false;
  const expected = createHmac('sha256', input.secret)
    .update(input.timestamp, 'ascii')
    .update('.')
    .update(input.rawBody)
    .digest();
  const supplied = Buffer.from(input.signature.slice(3), 'hex');
  return (
    expected.byteLength === supplied.byteLength &&
    timingSafeEqual(expected, supplied)
  );
}
