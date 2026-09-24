import { randomUUID } from 'node:crypto';

import { createAuthenticationMailEnqueueStore } from '@pertexo/database/api';
import { createAuthenticationMailDeliveryStore } from '@pertexo/database/execution';
import { migrateDatabase } from '@pertexo/database/testing';
import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { createAuthenticationMailDeliveryHandler } from '../src/execution/authentication-mail-delivery.js';

const databaseName = `pertexo_test_auth_delivery_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';

function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const storeConfig = (connectionString: string) => ({
  connectionString,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  max: 1,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
});

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    apiRuntimeRole: 'pertexo_api',
    connectionString: databaseUrl(migrationBaseUrl),
    dispatcherRole: 'pertexo_dispatcher',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    maintenanceRole: 'pertexo_maintenance',
    operatorRole: 'pertexo_operator',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  });
}, 60_000);

afterAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`drop database if exists "${databaseName}"`);
  } finally {
    await admin.end();
  }
}, 30_000);

it('delivers an API-sealed command through the real worker role and clears ciphertext', async () => {
  const api = createAuthenticationMailEnqueueStore(
    storeConfig(databaseUrl(apiBaseUrl)),
  );
  const worker = createAuthenticationMailDeliveryStore(
    storeConfig(databaseUrl(workerBaseUrl)),
  );
  const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
  const envelope = createApplicationSecretEnvelope({
    current: { version: 'v1', key: Buffer.alloc(32, 6).toString('base64') },
  });
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 60_000);
  const sendNotification = vi.fn().mockResolvedValue({
    kind: 'succeeded',
    emailId: 'fake-provider-reference',
  });
  try {
    await api.enqueue({
      id,
      purpose: 'password_reset',
      expiresAt,
      sealedPayload: envelope.seal(
        JSON.stringify({
          fromEmail: 'security@example.test',
          toEmail: 'recipient@example.test',
          subject: 'Reset your password',
          text: 'Immutable local test message',
        }),
        `pertexo/authentication-mail/v1/password_reset/${id}/${expiresAt.toISOString()}`,
      ),
    });
    const before = await owner.query<{ payload_ciphertext: string | null }>(
      `select payload_ciphertext from app.authentication_mail_deliveries where id=$1`,
      [id],
    );
    expect(before.rows[0]?.payload_ciphertext).not.toContain(
      'recipient@example.test',
    );

    const handler = createAuthenticationMailDeliveryHandler({
      store: worker,
      envelope,
      email: { sendNotification },
      apiKey: 'fake-provider-key',
      timeoutMillis: 5_000,
      workerId: 'auth-mail:integration',
    });
    await expect(handler.runOnce()).resolves.toBe(1);
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: 'recipient@example.test',
        text: 'Immutable local test message',
        idempotencyKey: `authentication-mail:v1:${id}`,
      }),
    );
    const after = await owner.query<{
      status: string;
      payload_ciphertext: string | null;
      provider_reference: string | null;
    }>(
      `select status,payload_ciphertext,provider_reference from app.authentication_mail_deliveries where id=$1`,
      [id],
    );
    expect(after.rows[0]).toEqual({
      status: 'submitted',
      payload_ciphertext: null,
      provider_reference: 'fake-provider-reference',
    });
    await expect(handler.runOnce()).resolves.toBe(0);
    expect(sendNotification).toHaveBeenCalledOnce();
  } finally {
    await Promise.all([api.close(), worker.close(), owner.end()]);
  }
}, 30_000);
