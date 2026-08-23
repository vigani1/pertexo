import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { canonicalOutboxPayloadChecksum } from '../src/outbox.js';
import { PHASE3_COMPATIBILITY_EXPECTATION } from './phase3-compatibility-fixture.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const databaseName = `pertexo_test_preview_retention_upgrade_${randomUUID().replaceAll('-', '')}`;

function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: databaseUrl(migrationBaseUrl),
  dispatcherRole: 'pertexo_dispatcher',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

async function createDatabase(): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
    );
  } finally {
    await admin.end();
  }
}

async function dropDatabase(): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
}

async function migrateThrough0023(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-0023-'));
  try {
    const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
      (migration) => /^\d{4}_.+\.sql$/u.test(migration) && migration < '0024_',
    );
    await Promise.all(
      migrations.map((migration) =>
        copyFile(
          path.join(MIGRATIONS_DIRECTORY, migration),
          path.join(directory, migration),
        ),
      ),
    );
    await migrateDatabase(migrationConfig, directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

beforeAll(createDatabase);
afterAll(dropDatabase);

describe('preview retention migration', () => {
  it('backfills checksum-valid cleanup delivery for a retained 0023 preview', async () => {
    await migrateThrough0023();

    const actorUserId = randomUUID();
    const workspaceId = randomUUID();
    const workflowId = randomUUID();
    const previewRunId = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    const traceparent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    const owner = new Pool({
      connectionString: migrationConfig.connectionString,
    });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query(
        `insert into app.users (id,email,display_name,status)
         values ($1,$2,'Retention upgrade','active')`,
        [actorUserId, `retention-upgrade-${actorUserId}@example.test`],
      );
      await owner.query(
        `insert into app.workspaces (id,name,slug,status,created_by)
         values ($1,'Retention upgrade',$2,'active',$3)`,
        [workspaceId, `retention-upgrade-${workspaceId}`, actorUserId],
      );
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        `insert into app.workflows
           (id,workspace_id,name,lifecycle_status,activation_status,created_by)
         values ($1,$2,'Retention target','active','inactive',$3)`,
        [workflowId, workspaceId, actorUserId],
      );
      await owner.query(
        `insert into app.preview_runs (
           id,workspace_id,workflow_id,draft_revision,draft_fingerprint,node_id,
           definition_key,definition_version,executor_key,executor_version,
           compatibility_release_epoch,compatibility_release_fingerprint,
           actor_user_id,idempotency_key_hash,request_hash,executable_node_json,
           input_ref,side_effect_class,may_contact_provider,
           may_cause_external_side_effect,dry_run,traceparent,expires_at
         ) values (
           $1,$2,$3,1,$4,'node-1','core.set',1,'core.set',1,$5,$6,$7,$8,$9,
           '{"id":"node-1","type":"core.set"}'::jsonb,
           '{"kind":"manual","value":null}'::jsonb,'safe',false,false,
           'not_supported',$10,$11
         )`,
        [
          previewRunId,
          workspaceId,
          workflowId,
          'c'.repeat(64),
          PHASE3_COMPATIBILITY_EXPECTATION.epoch,
          PHASE3_COMPATIBILITY_EXPECTATION.fingerprint,
          actorUserId,
          'd'.repeat(64),
          'e'.repeat(64),
          traceparent,
          expiresAt,
        ],
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await owner.end();
    }

    await expect(migrateDatabase(migrationConfig)).resolves.toEqual([
      '0024_preview_retention_cleanup.sql',
      '0025_preview_cleanup_idempotency.sql',
    ]);

    const verification = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    try {
      await verification.query('begin');
      await verification.query(
        "select set_config('app.workspace_id',$1,true)",
        [workspaceId],
      );
      const result = await verification.query<{
        available_at: Date;
        id: string;
        payload: Record<string, unknown>;
        payload_checksum: string;
      }>(
        `select id,payload,payload_checksum,available_at
           from app.outbox_events
          where workspace_id=$1 and aggregate_id=$2
            and job_name='sweep-expired-previews'`,
        [workspaceId, previewRunId],
      );
      expect(result.rows).toHaveLength(1);
      const event = result.rows[0];
      if (event === undefined) throw new Error('cleanup backfill missing');
      expect(event.payload).toEqual({
        outboxEventId: event.id,
        previewRunId,
        schemaVersion: 1,
        traceparent,
        workspaceId,
      });
      expect(event.payload_checksum).toBe(
        canonicalOutboxPayloadChecksum(event.payload),
      );
      expect(event.available_at.getTime()).toBe(expiresAt.getTime());
      await verification.query('commit');
    } catch (error: unknown) {
      await verification.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await verification.end();
    }
  });
});
