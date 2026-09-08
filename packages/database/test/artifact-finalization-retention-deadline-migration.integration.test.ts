import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const databaseName = `pertexo_test_0083_artifact_deadline_${randomUUID().replaceAll('-', '')}`;

const database = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: [
    'pertexo_migration',
    'pertexo_api',
    'pertexo_worker',
    'pertexo_dispatcher',
    'pertexo_maintenance',
    'pertexo_lifecycle_command',
    'pertexo_operator',
  ],
  databaseName,
  ownerRole: 'pertexo_owner',
});
const { databaseUrl } = database;

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: databaseUrl(migrationBaseUrl),
  dispatcherRole: 'pertexo_dispatcher',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  maintenanceRole: 'pertexo_maintenance',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

interface ArtifactDeadlineRow {
  expires_at: Date;
  finalized_at: Date | null;
  id: string;
  purpose: string;
  status: string;
  updated_at: Date;
}

function artifactInput(input: {
  readonly expiresAt: Date;
  readonly finalizedAt: Date | null;
  readonly id: string;
  readonly purpose: string;
  readonly status: 'available' | 'pending';
  readonly workspaceId: string;
}) {
  return [
    input.id,
    input.workspaceId,
    input.purpose,
    `workspaces/${input.workspaceId}/artifacts/${input.id}`,
    input.id.replaceAll('-', '').padEnd(64, '0').slice(0, 64),
    input.status,
    input.expiresAt,
    input.finalizedAt,
  ] as const;
}

beforeAll(database.create, 30_000);
afterAll(database.drop);

describe('artifact finalization retention deadline prior-head migration', () => {
  it('backfills only short legacy user-upload deadlines across FORCE RLS workspaces', async () => {
    const priorDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-0082-artifact-deadline-'),
    );
    try {
      const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
        (name) => /^\d{4}_.+\.sql$/u.test(name) && name < '0083_',
      );
      await Promise.all(
        migrations.map((name) =>
          copyFile(
            path.join(MIGRATIONS_DIRECTORY, name),
            path.join(priorDirectory, name),
          ),
        ),
      );
      const prior = await migrateDatabase(migrationConfig, priorDirectory);
      expect(prior.at(-1)).toBe(
        '0082_legal_hold_destruction_serialization.sql',
      );

      const workspaceA = randomUUID();
      const workspaceB = randomUUID();
      const userId = randomUUID();
      const shortA = randomUUID();
      const shortB = randomUUID();
      const longer = randomUUID();
      const pending = randomUUID();
      const unrelated = randomUUID();
      const finalizedA = new Date('2026-07-01T10:00:00.000Z');
      const finalizedB = new Date('2026-07-02T11:30:00.000Z');
      const legacyDeadlineA = new Date(finalizedA.getTime() + 15 * 60_000);
      const legacyDeadlineB = new Date(finalizedB.getTime() + 15 * 60_000);
      const longerDeadline = new Date(
        finalizedA.getTime() + 45 * 24 * 60 * 60_000,
      );
      const pendingDeadline = new Date('2026-07-03T12:00:00.000Z');
      const unrelatedDeadline = new Date(
        finalizedA.getTime() + 10 * 24 * 60 * 60_000,
      );
      const originalUpdatedAt = new Date('2026-07-01T10:05:00.000Z');

      const owner = new Pool({
        connectionString: databaseUrl(migrationBaseUrl),
        max: 1,
      });
      try {
        const rls = await owner.query<{
          owner_bypasses_rls: boolean;
          rls_enabled: boolean;
          rls_forced: boolean;
        }>(
          `select class.relrowsecurity rls_enabled,
                  class.relforcerowsecurity rls_forced,
                  role.rolbypassrls owner_bypasses_rls
             from pg_class class
             join pg_namespace namespace on namespace.oid=class.relnamespace
             join pg_roles role on role.rolname='pertexo_owner'
            where namespace.nspname='app' and class.relname='artifacts'`,
        );
        expect(rls.rows).toEqual([
          {
            owner_bypasses_rls: false,
            rls_enabled: true,
            rls_forced: true,
          },
        ]);

        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query(
          `insert into app.users(id,email,display_name)
           values($1,$2,'Artifact deadline fixture')`,
          [userId, `${userId}@example.test`],
        );
        await owner.query(
          `insert into app.workspaces(id,name,slug,created_by)
           values
             ($1,'Artifact deadline A',$3,$5),
             ($2,'Artifact deadline B',$4,$5)`,
          [
            workspaceA,
            workspaceB,
            `artifact-deadline-a-${workspaceA}`,
            `artifact-deadline-b-${workspaceB}`,
            userId,
          ],
        );

        const insertArtifact = async (
          workspaceId: string,
          values: ReturnType<typeof artifactInput>,
        ): Promise<void> => {
          await owner.query("select set_config('app.workspace_id',$1,true)", [
            workspaceId,
          ]);
          await owner.query(
            `insert into app.artifacts(
               id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
               status,expires_at,finalized_at,created_at,updated_at
             ) values($1,$2,$3,$4,'application/octet-stream',17,$5,$6,$7,$8,$9,$10)`,
            [...values, originalUpdatedAt, originalUpdatedAt],
          );
        };

        await insertArtifact(
          workspaceA,
          artifactInput({
            expiresAt: legacyDeadlineA,
            finalizedAt: finalizedA,
            id: shortA,
            purpose: 'user-upload',
            status: 'available',
            workspaceId: workspaceA,
          }),
        );
        await insertArtifact(
          workspaceA,
          artifactInput({
            expiresAt: longerDeadline,
            finalizedAt: finalizedA,
            id: longer,
            purpose: 'user-upload',
            status: 'available',
            workspaceId: workspaceA,
          }),
        );
        await insertArtifact(
          workspaceA,
          artifactInput({
            expiresAt: pendingDeadline,
            finalizedAt: null,
            id: pending,
            purpose: 'user-upload',
            status: 'pending',
            workspaceId: workspaceA,
          }),
        );
        await insertArtifact(
          workspaceA,
          artifactInput({
            expiresAt: unrelatedDeadline,
            finalizedAt: finalizedA,
            id: unrelated,
            purpose: 'run-output',
            status: 'available',
            workspaceId: workspaceA,
          }),
        );
        await insertArtifact(
          workspaceB,
          artifactInput({
            expiresAt: legacyDeadlineB,
            finalizedAt: finalizedB,
            id: shortB,
            purpose: 'user-upload',
            status: 'available',
            workspaceId: workspaceB,
          }),
        );
        await owner.query('commit');
      } catch (error: unknown) {
        await owner.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        await owner.end();
      }

      await expect(migrateDatabase(migrationConfig)).resolves.toEqual([
        '0083_artifact_finalization_retention_deadline.sql',
      ]);

      const api = new Pool({
        connectionString: databaseUrl(apiBaseUrl),
        max: 1,
      });
      const readWorkspace = async (
        workspaceId: string,
      ): Promise<ArtifactDeadlineRow[]> => {
        await api.query('begin');
        try {
          await api.query("select set_config('app.workspace_id',$1,true)", [
            workspaceId,
          ]);
          const result = await api.query<ArtifactDeadlineRow>(
            `select id,purpose,status,expires_at,finalized_at,updated_at
               from app.artifacts order by id`,
          );
          await api.query('commit');
          return result.rows;
        } catch (error: unknown) {
          await api.query('rollback').catch(() => undefined);
          throw error;
        }
      };
      try {
        const rowsA = await readWorkspace(workspaceA);
        const rowsB = await readWorkspace(workspaceB);
        expect(rowsA.map((row) => row.id).sort()).toEqual(
          [shortA, longer, pending, unrelated].sort(),
        );
        expect(rowsB.map((row) => row.id)).toEqual([shortB]);

        const byId = new Map(
          [...rowsA, ...rowsB].map((row) => [row.id, row] as const),
        );
        expect(byId.get(shortA)?.expires_at.getTime()).toBe(
          finalizedA.getTime() + 30 * 24 * 60 * 60_000,
        );
        expect(byId.get(shortB)?.expires_at.getTime()).toBe(
          finalizedB.getTime() + 30 * 24 * 60 * 60_000,
        );
        expect(byId.get(longer)?.expires_at.getTime()).toBe(
          longerDeadline.getTime(),
        );
        expect(byId.get(pending)).toMatchObject({
          finalized_at: null,
          purpose: 'user-upload',
          status: 'pending',
        });
        expect(byId.get(pending)?.expires_at.getTime()).toBe(
          pendingDeadline.getTime(),
        );
        expect(byId.get(unrelated)).toMatchObject({
          purpose: 'run-output',
          status: 'available',
        });
        expect(byId.get(unrelated)?.expires_at.getTime()).toBe(
          unrelatedDeadline.getTime(),
        );
        expect(byId.get(longer)?.updated_at.getTime()).toBe(
          originalUpdatedAt.getTime(),
        );
        expect(byId.get(pending)?.updated_at.getTime()).toBe(
          originalUpdatedAt.getTime(),
        );
        expect(byId.get(unrelated)?.updated_at.getTime()).toBe(
          originalUpdatedAt.getTime(),
        );
        expect(byId.get(shortA)?.updated_at.getTime()).toBeGreaterThan(
          originalUpdatedAt.getTime(),
        );
        expect(byId.get(shortB)?.updated_at.getTime()).toBeGreaterThan(
          originalUpdatedAt.getTime(),
        );
      } finally {
        await api.end();
      }
    } finally {
      await rm(priorDirectory, { recursive: true, force: true });
    }
  }, 120_000);
});
