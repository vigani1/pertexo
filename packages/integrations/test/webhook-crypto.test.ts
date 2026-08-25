import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  WebhookTriggerEnvelopeEncryption,
  webhookTriggerSecretAssociatedData,
  verifyWebhookSignature,
  type WebhookEnvelopeKeyProvider,
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
