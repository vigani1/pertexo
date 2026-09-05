import { createHmac, randomBytes } from 'node:crypto';

import {
  GenerateDataKeyCommand,
  type DecryptCommand,
} from '@aws-sdk/client-kms';
import { describe, expect, it, vi } from 'vitest';

import {
  AwsKmsWebhookEnvelopeKeyProvider,
  WebhookTriggerEnvelopeEncryption,
  WebhookTriggerSecretEncryptionError,
  webhookTriggerSecretAssociatedData,
  verifyWebhookSignature,
  type WebhookEnvelopeKeyProvider,
  type WebhookKmsClientLike,
} from '../src/webhooks/crypto.js';

const context = {
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  triggerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  secretVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

describe('webhook trigger crypto', () => {
  it('binds ciphertext to the webhook trigger purpose and destroys plaintext inputs', async () => {
    const dataKey = new Uint8Array(32).fill(7);
    const keys: WebhookEnvelopeKeyProvider = {
      generateDataKey: vi.fn().mockResolvedValue({
        plaintextKey: dataKey,
        encryptedDataKey: new Uint8Array([1, 2, 3]),
        keyReference: 'kms-key',
      }),
      decryptDataKey: vi
        .fn()
        .mockImplementation(() => Promise.resolve(new Uint8Array(32).fill(7))),
    };
    const encryption = new WebhookTriggerEnvelopeEncryption(keys);
    const secret = new Uint8Array(32).fill(9);
    const sealed = await encryption.seal(secret, context);

    expect(secret).toEqual(new Uint8Array(32));
    expect(dataKey).toEqual(new Uint8Array(32));
    await expect(
      encryption.open(sealed, { ...context, triggerId: context.workspaceId }),
    ).rejects.toMatchObject({ name: 'WebhookTriggerSecretEncryptionError' });
    const opened = await encryption.open(sealed, context);
    expect(opened).toEqual(new Uint8Array(32).fill(9));
    opened.fill(0);
    expect(
      new TextDecoder().decode(webhookTriggerSecretAssociatedData(context)),
    ).toBe(
      `pertexo:webhook-trigger-secret:v1\0${context.workspaceId}\0${context.triggerId}\0${context.secretVersionId}`,
    );
  });

  it('rejects malformed envelopes and tampering through one opaque error', async () => {
    const keys: WebhookEnvelopeKeyProvider = {
      generateDataKey: () =>
        Promise.resolve({
          plaintextKey: new Uint8Array(32).fill(7),
          encryptedDataKey: new Uint8Array([1, 2, 3]),
          keyReference: 'kms-key',
        }),
      decryptDataKey: () => Promise.resolve(new Uint8Array(32).fill(7)),
    };
    const encryption = new WebhookTriggerEnvelopeEncryption(keys);
    const sealed = await encryption.seal(new Uint8Array(32).fill(9), context);

    for (const candidate of [
      { ...sealed, authTag: `${sealed.authTag}A` },
      { ...sealed, nonce: '' },
      { ...sealed, encryptedDataKey: '*' },
      { ...sealed, ciphertext: `${sealed.ciphertext}A` },
    ])
      await expect(encryption.open(candidate, context)).rejects.toEqual(
        expect.objectContaining({
          name: 'WebhookTriggerSecretEncryptionError',
          message: 'Webhook trigger secret encryption failed',
        }),
      );
  });

  it('clears caller-owned secret bytes when context admission fails', async () => {
    const encryption = new WebhookTriggerEnvelopeEncryption({
      generateDataKey: vi.fn(),
      decryptDataKey: vi.fn(),
    });
    const secret = new Uint8Array(32).fill(9);

    await expect(
      encryption.seal(secret, { ...context, triggerId: 'invalid' }),
    ).rejects.toBeInstanceOf(WebhookTriggerSecretEncryptionError);
    expect([...secret]).toEqual(new Array<number>(32).fill(0));
  });

  it('verifies lowercase v1 HMAC over timestamp dot exact raw bytes', () => {
    const secret = new Uint8Array(32).fill(3);
    const rawBody = new TextEncoder().encode('{"value": 1}\n');
    const timestamp = '1787659200';
    const signature = `v1=${createHmac('sha256', secret)
      .update(timestamp, 'ascii')
      .update('.')
      .update(rawBody)
      .digest('hex')}`;

    expect(
      verifyWebhookSignature({ secret, timestamp, signature, rawBody }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        secret,
        timestamp,
        signature: signature.toUpperCase(),
        rawBody,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        secret,
        timestamp,
        signature,
        rawBody: new TextEncoder().encode('{"value":1}\n'),
      }),
    ).toBe(false);
  });
});

describe('AWS KMS webhook envelope-key adapter', () => {
  it('binds both operations to the webhook identity context', async () => {
    const commands: (GenerateDataKeyCommand | DecryptCommand)[] = [];
    const client: WebhookKmsClientLike = {
      send: (command) => {
        commands.push(command);
        return Promise.resolve(
          command instanceof GenerateDataKeyCommand
            ? {
                Plaintext: randomBytes(32),
                CiphertextBlob: randomBytes(96),
                KeyId: 'arn:aws:kms:eu-central-1:123456789012:key/webhook',
              }
            : { Plaintext: randomBytes(32) },
        );
      },
    };
    const provider = new AwsKmsWebhookEnvelopeKeyProvider(
      client,
      'alias/pertexo-webhooks',
    );

    const generated = await provider.generateDataKey(context);
    await provider.decryptDataKey(
      generated.encryptedDataKey,
      generated.keyReference,
      context,
    );

    expect(commands).toHaveLength(2);
    for (const command of commands)
      expect(command.input.EncryptionContext).toEqual({
        purpose: 'pertexo-webhook-trigger-secret',
        schemaVersion: '1',
        workspaceId: context.workspaceId,
        triggerId: context.triggerId,
        secretVersionId: context.secretVersionId,
      });
  });

  it('forwards cancellation and clears KMS plaintext returned after abort', async () => {
    const controller = new AbortController();
    const latePlaintext = randomBytes(32);
    let resolveKms: ((value: unknown) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const client: WebhookKmsClientLike = {
      send: (_command, options) => {
        observedSignal = options?.abortSignal;
        return new Promise((resolve) => {
          resolveKms = resolve;
        });
      },
    };
    const provider = new AwsKmsWebhookEnvelopeKeyProvider(
      client,
      'alias/pertexo-webhooks',
    );

    const pending = provider.decryptDataKey(
      randomBytes(96),
      'alias/pertexo-webhooks',
      context,
      controller.signal,
    );
    await Promise.resolve();
    expect(observedSignal).toBe(controller.signal);
    controller.abort();
    resolveKms?.({ Plaintext: latePlaintext });

    await expect(pending).rejects.toBeInstanceOf(
      WebhookTriggerSecretEncryptionError,
    );
    expect([...latePlaintext]).toEqual(new Array<number>(32).fill(0));
  });
});
