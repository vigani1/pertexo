import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const databaseName = `pertexo_test_schedule_claim_migration_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = (() => {
  const url = new URL(migrationBaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
})();
const migrationConfig = {
  connectionString: databaseUrl,
  ownerRole: 'pertexo_owner',
  apiRuntimeRole: 'pertexo_api',
  workerRuntimeRole: 'pertexo_worker',
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  operatorRole: 'pertexo_operator',
} as const;

const helperFunctionNames = [
  'schedule_claim_is_eligible',
  'complete_trigger_schedule_claim',
  'release_trigger_schedule_claim',
  'defer_trigger_schedule_claim',
  'fail_trigger_schedule_claim',
] as const;

interface FunctionMetadata {
  identity_arguments: string;
  name: string;
  owner: string;
  privileges: string[];
  proconfig: string[] | null;
  prosecdef: boolean;
}

let priorDirectory = '';

async function readFunctionMetadata(
  pool: Pool,
  names: readonly string[],
): Promise<FunctionMetadata[]> {
  const result = await pool.query<FunctionMetadata>(
    `select p.proname name,pg_get_function_identity_arguments(p.oid) identity_arguments,
       pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,
       coalesce(array_agg(
         case when acl.grantee=0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end
           || ':' || acl.privilege_type
         order by acl.grantee,acl.privilege_type
       ) filter(where acl.grantee is not null),'{}'::text[]) privileges
       from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       left join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl on true
      where n.nspname='app' and p.proname = any($1::text[])
      group by p.oid,p.proname,p.prosecdef,p.proconfig,p.proowner
      order by p.proname,pg_get_function_identity_arguments(p.oid)`,
    [names],
  );
  return result.rows;
}

async function readClaimFunctionDefinition(pool: Pool): Promise<string> {
  const result = await pool.query<{ body: string }>(
    `select pg_get_functiondef(p.oid) body
       from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='app' and p.proname='claim_due_trigger_schedules'`,
  );
  const body = result.rows[0]?.body;
  if (body === undefined)
    throw new Error('claim_due_trigger_schedules definition was not found');
  return body;
}

function readDueCte(definition: string): string {
  const due = /\bdue\s+as\s*\(([\s\S]*?)\),\s*claimed\s+as/iu.exec(
    definition,
  )?.[1];
  if (due === undefined)
    throw new Error('claim_due_trigger_schedules due CTE was not found');
  return due;
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,pertexo_api,pertexo_worker,pertexo_dispatcher,pertexo_maintenance,pertexo_lifecycle_command,pertexo_operator`,
    );
  } finally {
    await admin.end();
  }

  priorDirectory = await mkdtemp(path.join(tmpdir(), 'schedule-claim-prior-'));
  for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
    if (/^\d{4}_[a-z0-9_]+\.sql$/u.test(name) && name < '0081_')
      await copyFile(
        path.join(MIGRATIONS_DIRECTORY, name),
        path.join(priorDirectory, name),
      );
  }
});

afterAll(async () => {
  if (priorDirectory !== '')
    await rm(priorDirectory, { recursive: true, force: true });
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('schedule claim migration upgrade', () => {
  it('upgrades exactly from the 0080 head and preserves claim helper security', async () => {
    const prior = await migrateDatabase(migrationConfig, priorDirectory);
    expect(prior.at(-1)).toBe('0080_expired_artifact_upload_retention.sql');

    const inspection = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const userId = randomUUID();
      const workspaceId = randomUUID();
      const artifactId = randomUUID();
      const finalizedAt = new Date('2026-09-01T00:00:00.000Z');
      const legacyExpiry = new Date(finalizedAt.getTime() + 15 * 60_000);
      await inspection.query('begin');
      await inspection.query('set local role pertexo_owner');
      await inspection.query(
        `insert into app.users(id,email,display_name)
         values($1,$2,'Legacy artifact owner')`,
        [userId, `${userId}@example.test`],
      );
      await inspection.query(
        `insert into app.workspaces(id,name,slug,created_by)
         values($1,'Legacy artifact',$2,$3)`,
        [workspaceId, `legacy-artifact-${workspaceId}`, userId],
      );
      await inspection.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await inspection.query(
        `insert into app.artifacts(
           id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
           status,expires_at,finalized_at,created_at,updated_at
         ) values(
           $1,$2,'user-upload',$3,'application/octet-stream',17,$4,
           'available',$5,$6,$6,$6
         )`,
        [
          artifactId,
          workspaceId,
          `workspaces/${workspaceId}/artifacts/${artifactId}`,
          'f'.repeat(64),
          legacyExpiry,
          finalizedAt,
        ],
      );
      await inspection.query('commit');

      const claimBefore = await readFunctionMetadata(inspection, [
        'claim_due_trigger_schedules',
      ]);
      const helpersBefore = await readFunctionMetadata(
        inspection,
        helperFunctionNames,
      );
      await expect(migrateDatabase(migrationConfig)).resolves.toEqual([
        '0081_schedule_claim_concurrency.sql',
        '0082_legal_hold_destruction_serialization.sql',
        '0083_artifact_finalization_retention_deadline.sql',
        '0084_workspace_member_discovery_index.sql',
        '0085_artifact_media_type_http_safety.sql',
        '0086_operator_attempt_reclaim_state.sql',
      ]);
      const claimAfter = await readFunctionMetadata(inspection, [
        'claim_due_trigger_schedules',
      ]);
      const helpersAfter = await readFunctionMetadata(
        inspection,
        helperFunctionNames,
      );
      const definition = await readClaimFunctionDefinition(inspection);
      const dueCte = readDueCte(definition);

      expect(claimAfter).toEqual(claimBefore);
      expect(helpersAfter).toEqual(helpersBefore);
      const claim = claimAfter[0];
      if (claim === undefined)
        throw new Error('claim_due_trigger_schedules metadata was not found');
      expect(claim.owner).toBe('pertexo_owner');
      expect(claim.prosecdef).toBe(true);
      const normalizedConfig = (claim.proconfig ?? []).map((setting) =>
        setting.replaceAll(/\s+/gu, ''),
      );
      expect(normalizedConfig).toEqual(
        expect.arrayContaining([
          'search_path=pg_catalog,app,pg_temp',
          'row_security=on',
        ]),
      );
      expect(claim.privileges).toContain('pertexo_worker:EXECUTE');
      expect(claim.privileges).not.toContain('PUBLIC:EXECUTE');
      expect(claim.privileges).not.toContain('pertexo_api:EXECUTE');

      await inspection.query('begin');
      await inspection.query('set local role pertexo_owner');
      await inspection.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      const backfilled = await inspection.query<{ expires_at: Date }>(
        `select expires_at from app.artifacts
          where workspace_id=$1 and id=$2`,
        [workspaceId, artifactId],
      );
      await inspection.query('rollback');
      expect(backfilled.rows[0]?.expires_at.getTime()).toBe(
        finalizedAt.getTime() + 30 * 24 * 60 * 60_000,
      );

      expect(definition).toMatch(/ranked\s+as/iu);
      expect(dueCte).toMatch(/schedule\.status\s*=\s*'enabled'/iu);
      expect(dueCte).toMatch(/schedule\.next_fire_at\s*<=\s*v_observed_at/iu);
      expect(dueCte).toMatch(
        /schedule\.admission_deferred_until\s+is\s+null/iu,
      );
      expect(dueCte).toMatch(/schedule\.lease_expires_at\s+is\s+null/iu);
      expect(dueCte).toMatch(/trigger\.status\s*=\s*'active'/iu);
      expect(dueCte).toMatch(/for\s+update\s+of\s+schedule\s+skip\s+locked/iu);
    } finally {
      await inspection.end();
    }
  });
});
