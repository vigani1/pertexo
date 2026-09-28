import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEditorBrowserEnvelopeKeys } from './editor-browser-envelope-keys.mjs';

test('authenticates wrapped data keys by purpose and complete context across owners', async () => {
  const key = randomBytes(32);
  const context = {
    workspaceId: randomUUID(),
    connectionId: randomUUID(),
    secretVersionId: randomUUID(),
  };
  const sender = createEditorBrowserEnvelopeKeys(key, 'connection');
  const recipient = createEditorBrowserEnvelopeKeys(key, 'connection');
  const generated = await sender.generateDataKey(context);
  assert.equal(generated.encryptedDataKey.length, 60);
  const opened = await recipient.decryptDataKey(
    generated.encryptedDataKey,
    generated.keyReference,
    context,
  );
  assert.equal(timingSafeEqual(opened, generated.plaintextKey), true);
  opened.fill(0);
  for (const field of Object.keys(context)) {
    await assert.rejects(
      recipient.decryptDataKey(
        generated.encryptedDataKey,
        generated.keyReference,
        { ...context, [field]: randomUUID() },
      ),
      /Owned envelope key recovery failed/,
    );
  }
  const wrongKey = createEditorBrowserEnvelopeKeys(
    randomBytes(32),
    'connection',
  );
  await assert.rejects(
    wrongKey.decryptDataKey(
      generated.encryptedDataKey,
      generated.keyReference,
      context,
    ),
  );
  const wrongPurpose = createEditorBrowserEnvelopeKeys(key, 'webhook');
  await assert.rejects(
    wrongPurpose.decryptDataKey(
      generated.encryptedDataKey,
      generated.keyReference,
      {
        workspaceId: context.workspaceId,
        triggerId: context.connectionId,
        secretVersionId: context.secretVersionId,
      },
    ),
  );
  const tampered = generated.encryptedDataKey.slice();
  tampered[28] ^= 1;
  await assert.rejects(
    recipient.decryptDataKey(tampered, generated.keyReference, context),
  );
  sender.close();
  recipient.close();
  wrongKey.close();
  wrongPurpose.close();
  key.fill(0);
  generated.plaintextKey.fill(0);
  await assert.rejects(
    recipient.decryptDataKey(
      generated.encryptedDataKey,
      generated.keyReference,
      context,
    ),
  );
});

test('abort/errors never include caller secrets or wrapped material', async () => {
  const provider = createEditorBrowserEnvelopeKeys(randomBytes(32), 'webhook');
  const secret = 'endpoint-key-signature-connection-secret-probe';
  const signal = AbortSignal.abort(new Error(secret));
  await assert.rejects(
    provider.generateDataKey({ secret }, signal),
    (error) => {
      assert.equal(error.message, 'Owned envelope key generation failed');
      assert.equal(String(error.stack).includes(secret), false);
      return true;
    },
  );
  await assert.rejects(
    provider.decryptDataKey(Buffer.from(secret), secret, { secret }),
    (error) => {
      assert.equal(error.message, 'Owned envelope key recovery failed');
      assert.equal(String(error.stack).includes(secret), false);
      return true;
    },
  );
  provider.close();
});
