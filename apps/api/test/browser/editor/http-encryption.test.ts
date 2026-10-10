import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ConnectionEnvelopeEncryption,
  WebhookTriggerEnvelopeEncryption,
  type ConnectionSecretContext,
  type WebhookTriggerSecretContext,
} from '@pertexo/integrations/server';
import { createEditorBrowserEnvelopeKeys } from '../../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';

describe('actual owned connection and webhook envelope interfaces', () => {
  it('round-trips connection credentials across owners without plaintext DEK persistence', async () => {
    const master = randomBytes(32);
    const writeKeys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
      master,
      'connection',
    );
    const readKeys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
      master,
      'connection',
    );
    const write = new ConnectionEnvelopeEncryption(writeKeys),
      read = new ConnectionEnvelopeEncryption(readKeys);
    const context = {
      workspaceId: randomUUID(),
      connectionId: randomUUID(),
      secretVersionId: randomUUID(),
    };
    const plaintext = Buffer.from(
      '{"schemaVersion":1,"type":"http_headers","headers":{"authorization":"test-owned-only"}}',
    );
    const sealed = await write.seal(plaintext, context);
    const opened = await read.open(sealed, context);
    expect(timingSafeEqual(opened, plaintext)).toBe(true);
    opened.fill(0);
    expect(JSON.stringify(sealed).includes('test-owned-only')).toBe(false);
    await expect(
      read.open(sealed, { ...context, workspaceId: randomUUID() }),
    ).rejects.toThrow('Connection secret encryption failed');
    readKeys.close();
    await expect(read.open(sealed, context)).rejects.toThrow(
      'Connection secret encryption failed',
    );
    writeKeys.close();
    master.fill(0);
    plaintext.fill(0);
  });
  it('uses a separate webhook purpose and authenticated full context', async () => {
    const master = randomBytes(32);
    const keys = createEditorBrowserEnvelopeKeys<WebhookTriggerSecretContext>(
      master,
      'webhook',
    );
    const envelope = new WebhookTriggerEnvelopeEncryption(keys);
    const context = {
      workspaceId: randomUUID(),
      triggerId: randomUUID(),
      secretVersionId: randomUUID(),
    };
    const plaintext = randomBytes(32);
    const expected = Buffer.from(plaintext);
    const sealed = await envelope.seal(plaintext, context);
    const opened = await envelope.open(sealed, context);
    expect(timingSafeEqual(opened, expected)).toBe(true);
    opened.fill(0);
    expect(Buffer.from(sealed.encryptedDataKey, 'base64url').byteLength).toBe(
      60,
    );
    for (const field of [
      'workspaceId',
      'triggerId',
      'secretVersionId',
    ] as const)
      await expect(
        envelope.open(sealed, { ...context, [field]: randomUUID() }),
      ).rejects.toThrow('Webhook trigger secret encryption failed');
    const connectionKeys =
      createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
        master,
        'connection',
      );
    await expect(
      connectionKeys.decryptDataKey(
        Buffer.from(sealed.encryptedDataKey, 'base64url'),
        sealed.kmsKeyReference,
        {
          workspaceId: context.workspaceId,
          connectionId: context.triggerId,
          secretVersionId: context.secretVersionId,
        },
      ),
    ).rejects.toThrow('Owned envelope key recovery failed');
    keys.close();
    connectionKeys.close();
    master.fill(0);
    expected.fill(0);
  });
});
