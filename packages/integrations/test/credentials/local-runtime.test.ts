import { describe, expect, it } from 'vitest';
import {
  createConnectionEnvelopeEncryption,
  parseConnectionEncryptionConfig,
} from '../../src/credentials/runtime.js';

const key = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index),
).toString('base64');
const context = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  secretVersionId: '33333333-3333-4333-8333-333333333333',
};
const environment = {
  CONNECTION_ENCRYPTION_MODE: 'local',
  CONNECTION_LOCAL_KEY: key,
};

describe('local connection encryption', () => {
  it('shares encrypted secrets between independent API and worker runtimes', async () => {
    const api = createConnectionEnvelopeEncryption({ mode: 'local', key });
    const worker = createConnectionEnvelopeEncryption({ mode: 'local', key });
    const sealed = await api.encryption.seal(
      Buffer.from('local-secret'),
      context,
    );
    expect(
      Buffer.from(await worker.encryption.open(sealed, context)).toString(),
    ).toBe('local-secret');
    const next = await api.encryption.seal(
      Buffer.from('local-secret'),
      context,
    );
    expect(next.encryptedDataKey).not.toBe(sealed.encryptedDataKey);
    api.close();
    worker.close();
  });

  it.each(['workspaceId', 'connectionId', 'secretVersionId'] as const)(
    'binds a data key to %s',
    async (field) => {
      const runtime = createConnectionEnvelopeEncryption({
        mode: 'local',
        key,
      });
      const sealed = await runtime.encryption.seal(
        Buffer.from('secret'),
        context,
      );
      await expect(
        runtime.encryption.open(sealed, {
          ...context,
          [field]: '44444444-4444-4444-8444-444444444444',
        }),
      ).rejects.toThrow('Connection secret encryption failed');
    },
  );

  it('refuses a different master key, tampered data keys and aborted operations', async () => {
    const runtime = createConnectionEnvelopeEncryption({ mode: 'local', key });
    const sealed = await runtime.encryption.seal(
      Buffer.from('secret'),
      context,
    );
    const other = createConnectionEnvelopeEncryption({
      mode: 'local',
      key: Buffer.alloc(32, 99).toString('base64'),
    });
    await expect(other.encryption.open(sealed, context)).rejects.toThrow(
      'Connection secret encryption failed',
    );
    await expect(
      runtime.encryption.open(
        {
          ...sealed,
          encryptedDataKey: Buffer.from('invalid').toString('base64'),
        },
        context,
      ),
    ).rejects.toThrow('Connection secret encryption failed');
    await expect(
      runtime.encryption.seal(
        Buffer.from('secret'),
        context,
        AbortSignal.abort(),
      ),
    ).rejects.toThrow('Connection secret encryption failed');
  });

  it('validates the local key and refuses local mode when deployed', () => {
    expect(parseConnectionEncryptionConfig(environment, false)).toEqual({
      mode: 'local',
      key,
    });
    expect(() => parseConnectionEncryptionConfig(environment, true)).toThrow(
      'forbidden when deployed',
    );
    expect(() =>
      parseConnectionEncryptionConfig(
        { ...environment, CONNECTION_LOCAL_KEY: 'short' },
        false,
      ),
    ).toThrow('32 bytes');
    expect(() =>
      parseConnectionEncryptionConfig(
        { ...environment, CONNECTION_KMS_REGION: 'eu-central-1' },
        false,
      ),
    ).toThrow('cannot be mixed');
    expect(() =>
      parseConnectionEncryptionConfig({ CONNECTION_LOCAL_KEY: key }, false),
    ).toThrow('requires local encryption mode');
    expect(() =>
      parseConnectionEncryptionConfig(
        { CONNECTION_ENCRYPTION_MODE: 'local' },
        false,
      ),
    ).toThrow('requires CONNECTION_LOCAL_KEY');
  });

  it('keeps optional local disablement and deployed KMS requirements', () => {
    expect(parseConnectionEncryptionConfig({}, false)).toBeUndefined();
    expect(() => parseConnectionEncryptionConfig({}, true)).toThrow(
      'incomplete',
    );
    expect(
      parseConnectionEncryptionConfig(
        {
          CONNECTION_KMS_KEY_REFERENCE: 'alias/connections',
          CONNECTION_KMS_REGION: 'eu-central-1',
        },
        true,
      ),
    ).toEqual({ keyReference: 'alias/connections', region: 'eu-central-1' });
  });
});
