import { describe, expect, it } from 'vitest';
import {
  createConnectionEnvelopeEncryption,
  parseConnectionEncryptionConfig,
} from '../../src/credentials/runtime.js';
import { createWebhookTriggerEnvelopeEncryption } from '../../src/webhooks/crypto.js';

const key = Buffer.alloc(32, 7).toString('base64');
const secondKey = Buffer.alloc(32, 8).toString('base64');
const context = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  secretVersionId: '33333333-3333-4333-8333-333333333333',
};
const config = (
  value = key,
  version = '1',
  previous: readonly Readonly<{ version: string; key: string }>[] = [],
) => ({
  mode: 'self-managed' as const,
  encryption: { current: { version, key: value }, previous },
});
const environment = {
  CONNECTION_ENCRYPTION_MODE: 'self-managed',
  CONNECTION_SELF_MANAGED_KEY: key,
  CONNECTION_SELF_MANAGED_KEY_VERSION: '1',
};
const legacy = {
  kmsKeyReference: 'local:development',
  encryptedDataKey:
    'eyJjaXBoZXJ0ZXh0IjoibVc1T1hvbFZlSEdqSmV5WmNjUi1kRW9UcHZfd3pzQnRxaGFpaTZyNkUyY0pWSklNOHFhZmRWT3owZyIsIm5vbmNlIjoicEFPQ0pWb3NIaEFLeHQ4NiIsInRhZyI6InU2QTYzbGNlU2I1TVpnSWFCUHlXenciLCJrZXlWZXJzaW9uIjoibG9jYWw6ZGV2ZWxvcG1lbnQifQ',
  ciphertext: 'BwM0gVTGImcE1IwAcFg',
  nonce: 'pCaybz5RQTWJgon3',
  tag: 'R4KF-gFGgSfWA0AtTsno0w',
};

describe('self-managed connection encryption', () => {
  it('shares secrets between independent runtimes and uses fresh data keys', async () => {
    const api = createConnectionEnvelopeEncryption(config());
    const worker = createConnectionEnvelopeEncryption(config());
    const sealed = await api.encryption.seal(Buffer.from('secret'), context);
    expect(
      Buffer.from(await worker.encryption.open(sealed, context)).toString(),
    ).toBe('secret');
    expect(
      (await api.encryption.seal(Buffer.from('secret'), context))
        .encryptedDataKey,
    ).not.toBe(sealed.encryptedDataKey);
    expect(sealed.kmsKeyReference).toBe('self-managed');
    api.close();
    worker.close();
  });

  it.each(['workspaceId', 'connectionId', 'secretVersionId'] as const)(
    'binds keys to %s',
    async (field) => {
      const runtime = createConnectionEnvelopeEncryption(config());
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

  it('rotates without rewriting old connection or webhook secrets', async () => {
    const first = createConnectionEnvelopeEncryption(config());
    const nextConfig = config(secondKey, '2', [{ version: '1', key }]);
    const next = createConnectionEnvelopeEncryption(nextConfig);
    const sealed = await first.encryption.seal(Buffer.from('old'), context);
    expect(
      Buffer.from(await next.encryption.open(sealed, context)).toString(),
    ).toBe('old');
    const current = await next.encryption.seal(Buffer.from('new'), context);
    const wrap = JSON.parse(
      Buffer.from(current.encryptedDataKey, 'base64url').toString('utf8'),
    ) as { keyVersion: string };
    expect(wrap.keyVersion).toBe('2');
    await expect(first.encryption.open(current, context)).rejects.toThrow();
    const webhookContext = {
      workspaceId: context.workspaceId,
      triggerId: context.connectionId,
      secretVersionId: context.secretVersionId,
    };
    const oldWebhook = createWebhookTriggerEnvelopeEncryption(config());
    const rotatedWebhook = createWebhookTriggerEnvelopeEncryption(nextConfig);
    const webhook = await oldWebhook.encryption.seal(
      Buffer.alloc(32, 4),
      webhookContext,
    );
    expect(
      Buffer.from(
        await rotatedWebhook.encryption.open(webhook, webhookContext),
      ),
    ).toEqual(Buffer.alloc(32, 4));
  });

  it('opens fixed bytes written by the old development provider with its recorded version', async () => {
    const runtime = createConnectionEnvelopeEncryption(
      config(secondKey, '2', [{ version: 'local:development', key }]),
    );
    expect(
      Buffer.from(await runtime.encryption.open(legacy, context)).toString(),
    ).toBe('legacy-fixture');
    await expect(
      createConnectionEnvelopeEncryption(config(key)).encryption.open(
        legacy,
        context,
      ),
    ).rejects.toThrow();
  });

  it('refuses wrong key bytes, changed wraps and cancelled operations', async () => {
    const first = createConnectionEnvelopeEncryption(config());
    const sealed = await first.encryption.seal(Buffer.from('secret'), context);
    await expect(
      createConnectionEnvelopeEncryption(config(secondKey)).encryption.open(
        sealed,
        context,
      ),
    ).rejects.toThrow();
    await expect(
      first.encryption.open(
        {
          ...sealed,
          encryptedDataKey: Buffer.from('invalid').toString('base64url'),
        },
        context,
      ),
    ).rejects.toThrow();
    await expect(
      first.encryption.seal(
        Buffer.from('secret'),
        context,
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
  });

  it('normalizes legacy development input into the single provider', () => {
    expect(
      parseConnectionEncryptionConfig(
        { CONNECTION_ENCRYPTION_MODE: 'local', CONNECTION_LOCAL_KEY: key },
        false,
      ),
    ).toEqual(config(key, 'local:development'));
    expect(() =>
      parseConnectionEncryptionConfig(
        { CONNECTION_ENCRYPTION_MODE: 'local', CONNECTION_LOCAL_KEY: key },
        true,
      ),
    ).toThrow('forbidden when deployed');
    expect(() =>
      parseConnectionEncryptionConfig({ CONNECTION_LOCAL_KEY: key }, false),
    ).toThrow('requires local encryption mode');
  });

  it('parses versioned keys but keeps production closed until the serving gate exists', () => {
    expect(parseConnectionEncryptionConfig(environment, false)).toEqual(
      config(),
    );
    expect(() => parseConnectionEncryptionConfig(environment, true)).toThrow(
      'forbidden when deployed',
    );
  });

  it.each([
    { CONNECTION_SELF_MANAGED_KEY: undefined },
    { CONNECTION_SELF_MANAGED_KEY_VERSION: undefined },
    { CONNECTION_SELF_MANAGED_KEY: 'not-a-key' },
    { CONNECTION_SELF_MANAGED_KEY_VERSION: '!bad' },
    { CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: '{' },
    {
      CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: JSON.stringify([
        { version: '1', key: secondKey },
      ]),
    },
    {
      CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: JSON.stringify([
        { version: '0', key },
      ]),
    },
    {
      CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: JSON.stringify(
        Array.from({ length: 9 }, (_, index) => ({
          version: String(index + 2),
          key: secondKey,
        })),
      ),
    },
    { CONNECTION_KMS_REGION: 'eu-central-1' },
    { CONNECTION_LOCAL_KEY: key },
    { CONNECTION_ENCRYPTION_MODE: 'unknown' },
  ])(
    'refuses incomplete, duplicate, invalid or mixed configuration',
    (override) => {
      expect(() =>
        parseConnectionEncryptionConfig({ ...environment, ...override }, false),
      ).toThrow();
    },
  );

  it('sanitizes rejected values and preserves KMS configuration and optional development disablement', () => {
    expect(() =>
      parseConnectionEncryptionConfig(
        {
          ...environment,
          CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: 'private-invalid-material',
        },
        false,
      ),
    ).toThrow('Previous application keys are invalid');
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
    expect(() =>
      parseConnectionEncryptionConfig(
        { CONNECTION_ENCRYPTION_MODE: 'kms', CONNECTION_SELF_MANAGED_KEY: key },
        false,
      ),
    ).toThrow('require self-managed');
    expect(() =>
      parseConnectionEncryptionConfig(
        {
          CONNECTION_ENCRYPTION_MODE: 'local',
          CONNECTION_LOCAL_KEY: key,
          CONNECTION_SELF_MANAGED_KEY: key,
        },
        false,
      ),
    ).toThrow('cannot be mixed');
  });
});
