import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createConnectionEnvelopeEncryption } from '../../src/credentials/runtime.js';
import { createWebhookTriggerEnvelopeEncryption } from '../../src/webhooks/crypto.js';
import { SelfManagedEnvelopeKeyProvider } from '../../src/credentials/self-managed-key-provider.js';
import {
  verifyStoredEncryptionKeys,
  type StoredEncryptionKey,
} from '../../src/credentials/verify-stored-keys.js';

const key = Buffer.alloc(32, 7).toString('base64');
const nextKey = Buffer.alloc(32, 8).toString('base64');
const config = (
  current = key,
  version = '1',
  previous: readonly Readonly<{ version: string; key: string }>[] = [],
) => ({
  mode: 'self-managed' as const,
  encryption: { current: { key: current, version }, previous },
});
function rows(
  records: readonly StoredEncryptionKey[],
): AsyncIterable<StoredEncryptionKey> {
  return Readable.from(records);
}

async function sealed(
  kind: 'connection' | 'webhook',
  settings = config(),
): Promise<StoredEncryptionKey> {
  const base = {
    kind,
    workspaceId: randomUUID(),
    resourceId: randomUUID(),
    secretVersionId: randomUUID(),
  };
  if (kind === 'connection') {
    const runtime = createConnectionEnvelopeEncryption(settings);
    try {
      const envelope = await runtime.encryption.seal(
        Buffer.from('credential fixture'),
        {
          workspaceId: base.workspaceId,
          connectionId: base.resourceId,
          secretVersionId: base.secretVersionId,
        },
      );
      return {
        ...base,
        keyReference: envelope.kmsKeyReference,
        encryptedDataKey: envelope.encryptedDataKey,
      };
    } finally {
      runtime.close();
    }
  }
  const runtime = createWebhookTriggerEnvelopeEncryption(settings);
  try {
    const envelope = await runtime.encryption.seal(Buffer.alloc(32, 3), {
      workspaceId: base.workspaceId,
      triggerId: base.resourceId,
      secretVersionId: base.secretVersionId,
    });
    return {
      ...base,
      keyReference: envelope.kmsKeyReference,
      encryptedDataKey: envelope.encryptedDataKey,
    };
  } finally {
    runtime.close();
  }
}
describe('stored encryption key verification', () => {
  it('authenticates both purposes and historical master-key versions', async () => {
    const records = [
      await sealed('connection'),
      await sealed('webhook'),
      await sealed('connection', config(nextKey, '2')),
    ];
    await expect(
      verifyStoredEncryptionKeys(
        config(nextKey, '2', [{ version: '1', key }]),
        rows(records),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ connectionKeys: 2, webhookKeys: 1 });
  });
  it.each(['connection', 'webhook'] as const)(
    'refuses missing and wrong key material for a %s-only inventory',
    async (kind) => {
      const record = await sealed(kind);
      await expect(
        verifyStoredEncryptionKeys(
          config(nextKey, '2'),
          rows([record]),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'unavailable_key_material' });
      await expect(
        verifyStoredEncryptionKeys(
          config(nextKey),
          rows([record]),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'unavailable_key_material' });
    },
  );
  it('checks all rows and closes the source after a later corrupt wrap', async () => {
    const records = (
      await Promise.all(Array.from({ length: 260 }, () => sealed('connection')))
    ).map((record, index) =>
      index === 259
        ? {
            ...record,
            encryptedDataKey:
              Buffer.from('private-corruption').toString('base64url'),
          }
        : record,
    );
    const stream = Readable.from(records);
    const closed = finished(stream, { cleanup: true }).catch(() => undefined);
    const failure = await verifyStoredEncryptionKeys(
      config(),
      stream,
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'unavailable_key_material' });
    expect(String(failure)).not.toContain('private-corruption');
    await closed;
    expect(stream.destroyed).toBe(true);
  });
  it('refuses changed associated context', async () => {
    const record = await sealed('webhook');
    await expect(
      verifyStoredEncryptionKeys(
        config(),
        rows([{ ...record, workspaceId: randomUUID() }]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'unavailable_key_material' });
  });
  it('refuses provider switches in both directions without calling KMS', async () => {
    const self = await sealed('connection');
    const kms = {
      ...self,
      keyReference: 'arn:aws:kms:eu-central-1:123456789012:key/fixture',
      encryptedDataKey: 'opaque-kms-ciphertext',
    };
    const kmsConfig = { keyReference: 'alias/fixture', region: 'eu-central-1' };
    await expect(
      verifyStoredEncryptionKeys(
        config(),
        rows([kms]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'incompatible_provider' });
    await expect(
      verifyStoredEncryptionKeys(
        kmsConfig,
        rows([self]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'incompatible_provider' });
    await expect(
      verifyStoredEncryptionKeys(
        kmsConfig,
        rows([kms]),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ connectionKeys: 1, webhookKeys: 0 });
  });
  it('reports an empty inventory without creating a probe', async () => {
    await expect(
      verifyStoredEncryptionKeys(
        config(),
        rows([]),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ connectionKeys: 0, webhookKeys: 0 });
  });
  it('clears returned data-key material before returning', async () => {
    const plaintext = new Uint8Array(32).fill(9);
    const decrypt = vi
      .spyOn(SelfManagedEnvelopeKeyProvider.prototype, 'decryptDataKey')
      .mockResolvedValueOnce(plaintext);
    try {
      await verifyStoredEncryptionKeys(
        config(),
        rows([await sealed('connection')]),
        new AbortController().signal,
      );
      expect(plaintext).toEqual(new Uint8Array(32));
    } finally {
      decrypt.mockRestore();
    }
  });
  it('sanitizes inventory failures and abort reasons', async () => {
    const failure = new Readable({
      objectMode: true,
      read() {
        this.destroy(new Error('private-database-detail'));
      },
    });
    const result = await verifyStoredEncryptionKeys(
      config(),
      failure,
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(result).toMatchObject({ code: 'inventory_unavailable' });
    expect(String(result)).not.toContain('private-database-detail');
    await expect(
      verifyStoredEncryptionKeys(
        config(),
        rows([]),
        AbortSignal.abort(new Error('private-abort-detail')),
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});
