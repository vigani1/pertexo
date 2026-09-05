import type { KMSClient } from '@aws-sdk/client-kms';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createBoundedKmsClient } from '../credentials/kms-client.js';
import {
  AwsKmsEnvelopeKeyProviderCore,
  EnvelopeCipher,
  encodedEnvelopeSchemaFields,
  type EnvelopeKeyMaterial,
  type EnvelopeKeyProviderCore,
  type KmsSendLike,
} from '../crypto/envelope-cipher.js';

const WEBHOOK_SECRET_BYTES = 32;

const contextSchema = z
  .object({
    workspaceId: z.uuid(),
    triggerId: z.uuid(),
    secretVersionId: z.uuid(),
  })
  .strict();

const sealedSchema = z
  .object({
    ...encodedEnvelopeSchemaFields,
    authTag: z.string().min(1),
  })
  .strict();

export type WebhookTriggerSecretContext = Readonly<
  z.output<typeof contextSchema>
>;
export type SealedWebhookTriggerSecretEnvelope = Readonly<
  z.output<typeof sealedSchema>
>;
export type GeneratedWebhookEnvelopeKey = EnvelopeKeyMaterial;
export type WebhookKmsClientLike = KmsSendLike;
export type WebhookEnvelopeKeyProvider =
  EnvelopeKeyProviderCore<WebhookTriggerSecretContext>;

export class WebhookTriggerSecretEncryptionError extends Error {
  public override readonly name = 'WebhookTriggerSecretEncryptionError';

  public constructor() {
    super('Webhook trigger secret encryption failed');
  }
}

function failure(): WebhookTriggerSecretEncryptionError {
  return new WebhookTriggerSecretEncryptionError();
}

function encryptionContext(
  context: WebhookTriggerSecretContext,
): Readonly<Record<string, string>> {
  return Object.freeze({
    purpose: 'pertexo-webhook-trigger-secret',
    schemaVersion: '1',
    workspaceId: context.workspaceId,
    triggerId: context.triggerId,
    secretVersionId: context.secretVersionId,
  });
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
    ].join('\u0000'),
  );
}

export class AwsKmsWebhookEnvelopeKeyProvider implements WebhookEnvelopeKeyProvider {
  private readonly core: AwsKmsEnvelopeKeyProviderCore<WebhookTriggerSecretContext>;

  public constructor(
    client: Pick<KMSClient, 'send'> | WebhookKmsClientLike,
    keyReference: string,
  ) {
    this.core = new AwsKmsEnvelopeKeyProviderCore(
      client,
      keyReference,
      (context) => encryptionContext(contextSchema.parse(context)),
      failure,
    );
  }

  public async generateDataKey(
    context: WebhookTriggerSecretContext,
    signal?: AbortSignal,
  ): Promise<GeneratedWebhookEnvelopeKey> {
    try {
      return await this.core.generateDataKey(
        contextSchema.parse(context),
        signal,
      );
    } catch {
      throw failure();
    }
  }

  public async decryptDataKey(
    encryptedDataKey: Uint8Array,
    keyReference: string,
    context: WebhookTriggerSecretContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      return await this.core.decryptDataKey(
        encryptedDataKey,
        keyReference,
        contextSchema.parse(context),
        signal,
      );
    } catch {
      throw failure();
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
  private readonly cipher: EnvelopeCipher<WebhookTriggerSecretContext>;

  public constructor(keys: WebhookEnvelopeKeyProvider) {
    this.cipher = new EnvelopeCipher(keys, {
      associatedData: webhookTriggerSecretAssociatedData,
      createFailure: failure,
      maximumPlaintextBytes: WEBHOOK_SECRET_BYTES,
      exactPlaintextBytes: WEBHOOK_SECRET_BYTES,
      clearCallerPlaintext: true,
    });
  }

  public async seal(
    plaintext: Uint8Array,
    context: WebhookTriggerSecretContext,
    signal?: AbortSignal,
  ): Promise<SealedWebhookTriggerSecretEnvelope> {
    try {
      const sealed = await this.cipher.seal(
        plaintext,
        contextSchema.parse(context),
        signal,
      );
      return sealedSchema.parse({
        schemaVersion: 1,
        kmsKeyReference: sealed.keyReference,
        encryptedDataKey: sealed.encryptedDataKey,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        authTag: sealed.authTag,
      });
    } catch {
      throw failure();
    } finally {
      plaintext.fill(0);
    }
  }

  public async open(
    sealed: SealedWebhookTriggerSecretEnvelope,
    context: WebhookTriggerSecretContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      const parsed = sealedSchema.parse(sealed);
      return await this.cipher.open(
        {
          keyReference: parsed.kmsKeyReference,
          encryptedDataKey: parsed.encryptedDataKey,
          ciphertext: parsed.ciphertext,
          nonce: parsed.nonce,
          authTag: parsed.authTag,
        },
        contextSchema.parse(context),
        signal,
      );
    } catch {
      throw failure();
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
