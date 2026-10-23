import {
  createNoticePreferencesStore,
  createNoticeMailStore,
  createWorkspaceInboxFoldStore,
} from '@pertexo/database/notifications';
import { createIdentityWorkspaceDatabase } from '@pertexo/database/tenant-access';
import { openNoticeUnsubscribe } from '@pertexo/integrations/server';
import { sealNoticeMail } from '../../src/mail/notice-content.js';
import { randomUUID } from 'node:crypto';

import { createSystemMailEnqueueStore } from '@pertexo/database/platform';
import { createSystemMailDeliveryStore } from '@pertexo/database/platform';
import { migrateDatabase } from '@pertexo/database/testing';
import {
  createApplicationSecretEnvelope,
  createSystemMailClient,
} from '@pertexo/integrations/server';
import { Pool } from 'pg';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { createSystemMailDeliveryHandler } from '../../src/mail/delivery.js';

const databaseName = `pertexo_test_auth_delivery_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

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
});

beforeAll(prepareDeliveryIntegrationTestTsFixture, 60_000);

afterAll(closeDeliveryIntegrationTestTsFixture, 30_000);
registerDeliversAPISealedCommandThroughReal();

registerDeliversRealPersonalNoticeMailRefuses();

async function prepareDeliveryIntegrationTestTsFixture() {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_app, pertexo_maintenance`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    appRole: 'pertexo_app',
    connectionString: databaseUrl(migrationBaseUrl),
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
  });
}

async function closeDeliveryIntegrationTestTsFixture() {
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
}

function registerDeliversAPISealedCommandThroughReal(): void {
  it('delivers an API-sealed command through the real worker role and clears ciphertext', async () => {
    const api = createSystemMailEnqueueStore(
      storeConfig(databaseUrl(apiBaseUrl)),
    );
    const worker = createSystemMailDeliveryStore(
      storeConfig(databaseUrl(workerBaseUrl)),
    );
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    const envelope = createApplicationSecretEnvelope({
      current: { version: 'v1', key: Buffer.alloc(32, 6).toString('base64') },
    });
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    const sendNotification = vi.fn().mockResolvedValue({
      kind: 'submitted',
      reference: 'fake-provider-reference',
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
          `pertexo/authentication-mail/password_reset/${id}/${expiresAt.toISOString()}`,
        ),
      });
      const before = await owner.query<{ payload_ciphertext: string | null }>(
        `select payload_ciphertext from app.system_mail_deliveries where id=$1`,
        [id],
      );
      expect(before.rows[0]?.payload_ciphertext).not.toContain(
        'recipient@example.test',
      );

      const handler = createSystemMailDeliveryHandler({
        store: worker,
        envelope,
        email: { sendNotification, deduplicates: true },

        timeoutMillis: 5_000,
        workerId: 'auth-mail:integration',
      });
      await expect(handler.runOnce()).resolves.toBe(1);
      expect(sendNotification).toHaveBeenCalledOnce();
      expect(sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          toEmail: 'recipient@example.test',
          text: 'Immutable local test message',
          idempotencyKey: `authentication-mail:${id}`,
        }),
      );
      const after = await owner.query<{
        status: string;
        payload_ciphertext: string | null;
        provider_reference: string | null;
      }>(
        `select status,payload_ciphertext,provider_reference from app.system_mail_deliveries where id=$1`,
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

  it('delivers a sealed account command through a real SMTP session and fences lost acknowledgements', async () => {
    const messages: string[] = [];
    let acknowledge = true;
    const relay = new SMTPServer({
      logger: false,
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData: (stream, _session, callback) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          messages.push(Buffer.concat(chunks).toString());
          if (acknowledge) callback();
        });
      },
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const address = relay.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing SMTP fixture');
    const api = createSystemMailEnqueueStore(
      storeConfig(databaseUrl(apiBaseUrl)),
    );
    const worker = createSystemMailDeliveryStore(
      storeConfig(databaseUrl(workerBaseUrl)),
    );
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    const envelope = createApplicationSecretEnvelope({
      current: { version: 'v1', key: Buffer.alloc(32, 6).toString('base64') },
    });
    const client = createSystemMailClient({
      mode: 'smtp',
      host: '127.0.0.1',
      port: address.port,
      tls: 'none',
    });
    const handler = createSystemMailDeliveryHandler({
      store: worker,
      envelope,
      email: client,
      timeoutMillis: 500,
      workerId: 'smtp:integration',
    });
    const enqueue = async () => {
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + 60000);
      await api.enqueue({
        id,
        purpose: 'verification',
        expiresAt,
        sealedPayload: envelope.seal(
          JSON.stringify({
            fromEmail: 'security@example.test',
            toEmail: 'recipient@example.test',
            subject: 'Account verification',
            text: 'Immutable verification link',
          }),
          `pertexo/authentication-mail/verification/${id}/${expiresAt.toISOString()}`,
        ),
      });
      return id;
    };
    try {
      const first = await enqueue();
      await handler.runOnce();
      expect(
        (
          await owner.query(
            'select status from app.system_mail_deliveries where id=$1',
            [first],
          )
        ).rows[0],
      ).toEqual({ status: 'submitted' });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('Immutable verification link');
      acknowledge = false;
      const uncertain = await enqueue();
      await handler.runOnce();
      expect(
        (
          await owner.query(
            'select status from app.system_mail_deliveries where id=$1',
            [uncertain],
          )
        ).rows[0],
      ).toEqual({ status: 'reconciliation_required' });
      await handler.runOnce();
      expect(messages).toHaveLength(2);
      const crashed = await enqueue();
      await worker.claim({ workerId: 'smtp:crashed', limit: 1 });
      await owner.query(
        "update app.system_mail_deliveries set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
        [crashed],
      );
      await handler.runOnce();
      expect(messages).toHaveLength(2);
      expect(
        (
          await owner.query(
            'select status from app.system_mail_deliveries where id=$1',
            [crashed],
          )
        ).rows[0],
      ).toEqual({ status: 'reconciliation_required' });
    } finally {
      await Promise.all([
        api.close(),
        worker.close(),
        owner.end(),
        new Promise<void>((resolve) => {
          relay.close(resolve);
        }),
      ]);
    }
  }, 30000);
}

function registerDeliversRealPersonalNoticeMailRefuses(): void {
  it('delivers real personal notice mail, refuses revoked content before DATA, and never repeats a possible SMTP delivery', async () => {
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    const apiConfig = storeConfig(databaseUrl(apiBaseUrl));
    const maintenanceConfig = storeConfig(
      databaseUrl(
        process.env.DATABASE_MAINTENANCE_URL ??
          'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
      ),
    );
    const identity = createIdentityWorkspaceDatabase(apiConfig);
    const preferences = createNoticePreferencesStore(apiConfig, {
      emailAvailable: true,
    });
    const fold = createWorkspaceInboxFoldStore(apiConfig);
    const envelope = createApplicationSecretEnvelope({
      current: {
        version: 'notice-v1',
        key: Buffer.alloc(32, 17).toString('base64'),
      },
    });
    const notices = createNoticeMailStore(
      apiConfig,
      maintenanceConfig,
      (input) =>
        sealNoticeMail(
          envelope,
          'security@example.test',
          'https://app.example.test',
          input,
        ),
    );
    const deliveries = createSystemMailDeliveryStore(apiConfig);
    const messages: string[] = [];
    let acknowledge = true;
    let beforeConnect: () => Promise<void> = () => Promise.resolve();
    const relay = new SMTPServer({
      logger: false,
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onConnect: (_session, callback) => {
        void beforeConnect().then(
          () => {
            callback();
          },
          (error: unknown) => {
            callback(
              error instanceof Error ? error : new Error('Fixture refusal'),
            );
          },
        );
      },
      onData: (stream, _session, callback) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          messages.push(Buffer.concat(chunks).toString('utf8'));
          if (acknowledge) callback();
        });
      },
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const address = relay.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('SMTP relay missing');
    const handler = createSystemMailDeliveryHandler({
      store: deliveries,
      envelope,
      email: createSystemMailClient({
        mode: 'smtp',
        host: '127.0.0.1',
        port: address.port,
        tls: 'none',
      }),
      notices,
      timeoutMillis: 5000,
      workerId: 'notices:smtp-proof',
    });
    const seed = async () => {
      const user = (
        await identity.createUser({
          email: `${randomUUID()}@example.test`,
          displayName: 'Notice reader',
        })
      ).id;
      const workspaceId = (
        await identity.createWorkspaceWithOwner({
          ownerUserId: user,
          name: 'SMTP notice proof',
          slug: `notice-${randomUUID().slice(0, 10)}`,
        })
      ).id;
      await owner.query(
        'update app.users set email_verified=true where id=$1',
        [user],
      );
      const scope = { workspaceId, actorId: user };
      await preferences.replace({
        ...scope,
        mode: 'immediate',
        hour: 9,
        timeZone: 'UTC',
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
      const workflowId = randomUUID(),
        runId = randomUUID();
      await owner.query(
        "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Only the safe workflow name',$3)",
        [workflowId, workspaceId, user],
      );
      await owner.query(
        `with tenant as(select set_config('app.workspace_id',$2::text,true)), revision as(insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json) select $2::uuid,1,'{"PRIVATE":"NEVER_MAIL_VARIABLE"}'::jsonb from tenant returning workspace_id,revision) insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,input_ref,input_ref_expires_at,variable_set_revision) select $1::uuid,revision.workspace_id,$3::uuid,$4::uuid,'manual','failed','{"kind":"inline","value":{"private":"NEVER_MAIL_INPUT"}}'::jsonb,clock_timestamp()+interval '7 days',revision.revision from revision`,
        [runId, workspaceId, workflowId, randomUUID()],
      );
      await owner.query(
        "insert into app.workspace_inbox_events(id,workspace_id,workflow_id,run_id,terminal_event_sequence,kind,occurred_at) values($1,$2,$3,$4,1,'failed',clock_timestamp())",
        [randomUUID(), workspaceId, workflowId, runId],
      );
      await fold.foldPending(100);
      return scope;
    };
    const batch = async (workspaceId: string) =>
      (
        await owner.query<{
          id: string;
          status: string;
          failure_code: string | null;
        }>(
          'select delivery.id,delivery.status,delivery.failure_code from app.system_mail_deliveries delivery join app.notice_mail_batches batch on batch.id=delivery.id where batch.workspace_id=$1 order by batch.created_at desc limit 1',
          [workspaceId],
        )
      ).rows[0];
    try {
      const first = await seed();
      await handler.runOnce();
      expect(await batch(first.workspaceId)).toMatchObject({
        status: 'submitted',
      });
      expect(messages).toHaveLength(1);
      const raw = messages[0] ?? '';
      const bodyStart = raw.indexOf('\r\n\r\n');
      const headers = raw.slice(0, bodyStart),
        encoded = raw.slice(bodyStart + 4);
      const body = /Content-Transfer-Encoding: base64/iu.test(headers)
        ? Buffer.from(encoded, 'base64').toString('utf8')
        : /Content-Transfer-Encoding: quoted-printable/iu.test(headers)
          ? encoded
              .replace(/=\r?\n/gu, '')
              .replace(/=([A-F0-9]{2})/giu, (_match: string, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
              )
          : encoded;
      expect(body).toContain('Only the safe workflow name');
      expect(body).toContain(
        `https://app.example.test/w/${first.workspaceId}/inbox`,
      );
      expect(body).not.toContain('NEVER_MAIL');
      const token =
        /https:\/\/app\.example\.test\/notifications\/unsubscribe#([A-Za-z0-9_-]+)/u.exec(
          body,
        )?.[1];
      if (token === undefined)
        throw new Error('Notice unsubscribe capability missing');
      const claims = openNoticeUnsubscribe(envelope, token, new Date());
      expect(claims).toMatchObject({
        ...first,
        revision: 1,
        memberRevision: 1,
      });
      const unfoldedHeaders = headers.replace(/\r\n[ \t]+/gu, ' ');
      expect(unfoldedHeaders).toContain(
        `List-Unsubscribe: <https://app.example.test/v1/notifications/unsubscribe/one-click?token=${token}>`,
      );
      expect(unfoldedHeaders).toContain(
        'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
      );
      const revoked = await seed();
      beforeConnect = async () => {
        await preferences.replace({
          ...revoked,
          mode: 'off',
          hour: 9,
          timeZone: 'UTC',
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
        });
      };
      await handler.runOnce();
      expect(await batch(revoked.workspaceId)).toMatchObject({
        status: 'failed',
        failure_code: 'notice.superseded',
      });
      expect(messages).toHaveLength(1);
      beforeConnect = () => Promise.resolve();
      acknowledge = false;
      const uncertain = await seed();
      await handler.runOnce();
      expect(await batch(uncertain.workspaceId)).toMatchObject({
        status: 'reconciliation_required',
        failure_code: 'delivery.outcome_unknown',
      });
      expect(messages).toHaveLength(2);
      await handler.runOnce();
      expect(messages).toHaveLength(2);
      acknowledge = true;
      const crashed = await seed();
      await notices.prepare();
      const [claim] = await deliveries.claim({
        workerId: 'notices:crashed',
        limit: 1,
      });
      if (claim === undefined) throw new Error('Missing crash claim');
      expect((await batch(crashed.workspaceId))?.id).toBe(claim.id);
      await owner.query(
        "update app.system_mail_deliveries set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
        [claim.id],
      );
      await handler.runOnce();
      expect(await batch(crashed.workspaceId)).toMatchObject({
        status: 'reconciliation_required',
        failure_code: 'delivery.recovered_unknown',
      });
      expect(messages).toHaveLength(2);
    } finally {
      await Promise.all([
        identity.close(),
        preferences.close(),
        fold.close(),
        notices.close(),
        deliveries.close(),
        owner.end(),
        new Promise<void>((resolve) => {
          relay.close(resolve);
        }),
      ]);
    }
  }, 30000);
}
