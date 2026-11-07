import { createRetentionStore } from '@pertexo/core/lifecycle';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createApplicationSecretEnvelope,
  createSystemMailDeliveryHandler,
  createSystemMailDeliveryStore,
  createSystemMailEnqueueStore,
  verifySystemMailKeys,
  authenticationMailAssociatedData,
} from '@pertexo/secrets/server';
import {
  adminUrl,
  apiBaseUrl,
  databaseUrl,
  storeConfig,
  prepareDeliveryIntegrationTestTsFixture,
  closeDeliveryIntegrationTestTsFixture,
} from './system-mail-delivery.fixture.js';

const first = { version: 'v1', key: Buffer.alloc(32, 1).toString('base64') };
const second = { version: 'v2', key: Buffer.alloc(32, 2).toString('base64') };
const old = createApplicationSecretEnvelope({ current: first });
const missing = createApplicationSecretEnvelope({ current: second });
const restored = createApplicationSecretEnvelope({
  current: second,
  previous: [first],
});
let admin: Pool;
let store: ReturnType<typeof createSystemMailDeliveryStore>;
let enqueue: ReturnType<typeof createSystemMailEnqueueStore>;

beforeAll(async () => {
  await prepareDeliveryIntegrationTestTsFixture();
  admin = new Pool({ connectionString: databaseUrl(adminUrl), max: 2 });
  const config = storeConfig(databaseUrl(apiBaseUrl));
  store = createSystemMailDeliveryStore(config);
  enqueue = createSystemMailEnqueueStore(config);
});
afterAll(async () => {
  await Promise.all([store.close(), enqueue.close(), admin.end()]);
  await closeDeliveryIntegrationTestTsFixture();
});

it.each([false, true])(
  'retains near-expiry mail without spending delivery attempts when its key is missing, then sends once (deduplicates=%s)',
  async (deduplicates) => {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 30_000);
    const sealedPayload = old.seal(
      JSON.stringify({
        fromEmail: 'from@example.test',
        toEmail: 'to@example.test',
        subject: 'Reset',
        text: 'private synthetic link',
      }),
      authenticationMailAssociatedData('password_reset', id, expiresAt),
    );
    await enqueue.enqueue({
      id,
      purpose: 'password_reset',
      expiresAt,
      sealedPayload,
    });
    const warnings: string[] = [];
    // Missing retained mail keys are warnings; startup must not gate unrelated work.
    await expect(
      verifySystemMailKeys(
        storeConfig(
          databaseUrl(process.env.DATABASE_MAINTENANCE_URL ?? apiBaseUrl),
        ),
        ['v2'],
        (version) => warnings.push(version),
      ),
    ).resolves.toBeUndefined();
    expect(warnings).toEqual(['v1']);
    const sent: string[] = [];
    const handler = (envelope: typeof old) =>
      createSystemMailDeliveryHandler({
        store,
        envelope,
        workerId: 'key-recovery',
        timeoutMillis: 1_000,
        onUnavailableKey: (version) => warnings.push(version),
        email: {
          deduplicates,
          sendNotification: async (message) => {
            await message.beforeDispatch();
            sent.push(message.text);
            return { kind: 'submitted', reference: id };
          },
        },
      });
    await expect(handler(missing).runOnce()).resolves.toBe(1);
    expect(sent).toEqual([]);
    const pending = (
      await admin.query<Record<string, unknown>>(
        `select status,attempt_count,failure_code,payload_ciphertext,lease_owner,lease_token,lease_expires_at,
    next_attempt_at>expires_at retry_after_expiry from app.system_mail_deliveries where id=$1`,
        [id],
      )
    ).rows[0];
    expect(pending).toEqual({
      status: 'retry',
      attempt_count: 0,
      failure_code: 'delivery.payload_unavailable',
      payload_ciphertext: sealedPayload.ciphertext,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      retry_after_expiry: true,
    });
    expect(warnings).toEqual(['v1', 'v1']);
    await admin.query(
      'update app.system_mail_deliveries set next_attempt_at=clock_timestamp() where id=$1',
      [id],
    );
    await handler(restored).runOnce();
    await handler(restored).runOnce();
    expect(sent).toEqual(['private synthetic link']);
    expect(
      (
        await admin.query(
          'select status,attempt_count,payload_ciphertext from app.system_mail_deliveries where id=$1',
          [id],
        )
      ).rows,
    ).toEqual([
      { status: 'submitted', attempt_count: 1, payload_ciphertext: null },
    ]);
  },
);

it('keeps malformed and wrong-key payloads recoverable until their actual expiry', async () => {
  for (const envelope of [
    old,
    createApplicationSecretEnvelope({
      current: { ...first, key: Buffer.alloc(32, 7).toString('base64') },
    }),
  ]) {
    const id = randomUUID(),
      expiresAt = new Date(Date.now() + 30_000);
    const sealedPayload = old.seal(
      'not a mail payload',
      authenticationMailAssociatedData('verification', id, expiresAt),
    );
    await enqueue.enqueue({
      id,
      purpose: 'verification',
      expiresAt,
      sealedPayload,
    });
    const handler = createSystemMailDeliveryHandler({
      store,
      envelope,
      workerId: 'invalid-mail',
      timeoutMillis: 1_000,
      email: {
        deduplicates: false,
        sendNotification: () => {
          throw new Error('Invalid payload must not dispatch');
        },
      },
    });
    await expect(handler.runOnce()).rejects.toThrow(
      'Cannot open queued system mail',
    );
    expect(
      (
        await admin.query(
          'select status,attempt_count,payload_ciphertext from app.system_mail_deliveries where id=$1',
          [id],
        )
      ).rows,
    ).toEqual([
      {
        status: 'retry',
        attempt_count: 0,
        payload_ciphertext: sealedPayload.ciphertext,
      },
    ]);
    await admin.query(
      "update app.system_mail_deliveries set created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp() where id=$1",
      [id],
    );
    await expect(handler.runOnce()).resolves.toBe(0);
    const retention = createRetentionStore(
      storeConfig(
        databaseUrl(process.env.DATABASE_MAINTENANCE_URL ?? apiBaseUrl),
      ),
    );
    try {
      await retention.enforce();
    } finally {
      await retention.close();
    }
    expect(
      (
        await admin.query(
          'select payload_ciphertext from app.system_mail_deliveries where id=$1',
          [id],
        )
      ).rows,
    ).toEqual([{ payload_ciphertext: null }]);
  }
});
