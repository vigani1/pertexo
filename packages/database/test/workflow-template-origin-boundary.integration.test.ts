import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CURATED_WORKFLOW_TEMPLATES,
  workflowTemplateOriginSchema,
} from '@pertexo/workflow-model/curated-templates';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/graph';
import { parseDatabaseConfig } from '../src/config.js';
import { migrateDatabase } from '../src/migrations.js';
import {
  checkDatabaseReadiness,
  EXPECTED_MIGRATION_HEAD,
} from '../src/platform/readiness.js';
import { createIdentityWorkspaceDatabase } from '../src/tenant-access/identity-workspace.js';
import { WorkflowNotFoundError } from '../src/authoring/workflow-authoring-errors.js';
import { createWorkflowAuthoringFixtureDatabase } from './support/workflow-authoring-admission.fixture.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';
import { createArtifactMigrationConfig } from './support/artifact-migration-fixture.js';
import {
  recheckCuratedFixtureOwnership,
  verifyCuratedFixtureOwnership,
} from '../../../infrastructure/testing/curated-template-owned-fixture.mjs';

// Explicit role URLs must match canonical task ownership; there is no default
// or local-port fallback and this metadata suite never enables the writer.
const enabled = process.env.F06_ORIGIN_BOUNDARY_OWNED_FIXTURE === 'true';
const owned = enabled ? await verifyCuratedFixtureOwnership() : undefined;
const databaseName = `pertexo_test_f06_origin_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl:
    owned?.adminUrl ?? 'postgresql://disabled:disabled@invalid:1/postgres',
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_app'],
  databaseName,
  ownerRole: 'pertexo_owner',
});
const migrationUrl = fixture.databaseUrl(
  owned?.migrationUrl ?? 'postgresql://disabled:disabled@invalid:1/pertexo',
);
const apiUrl = fixture.databaseUrl(
  owned?.apiUrl ?? 'postgresql://disabled:disabled@invalid:1/pertexo',
);
const workerUrl = fixture.databaseUrl(
  owned?.workerUrl ?? 'postgresql://disabled:disabled@invalid:1/pertexo',
);
const template = CURATED_WORKFLOW_TEMPLATES.find(
  (item) => item.templateId === 'webhook-validation-routing',
);
if (template === undefined)
  throw new Error('Reviewed fixture basis is unavailable');
// Owner-seeded historical fixture, NOT evidence of SQL-guard-accepted origin.
// Its workflow uses an ordinary empty graph; origin never asserts resemblance.
const seededOrigin = workflowTemplateOriginSchema.parse({
  schemaVersion: 1,
  templateId: template.templateId,
  templateVersion: template.templateVersion,
  baseManifestDigest: template.baseManifestDigest,
  creationCommandDigest: 'c'.repeat(64),
  derivation: 'direct',
});
const emptyGraph = { schemaVersion: 1, nodes: [], edges: [], settings: {} };
const actorId = randomUUID(),
  otherActorId = randomUUID();
let workspaceId = '',
  otherWorkspaceId = '',
  sourceId = '',
  otherSourceId = '';
let identity: ReturnType<typeof createIdentityWorkspaceDatabase>;
let authoring: ReturnType<typeof createWorkflowAuthoringFixtureDatabase>;
let apiPool: Pool, ownerPool: Pool, workerPool: Pool;
let created = false;
const resources: { close(): Promise<void> }[] = [];

async function scoped<T>(
  pool: Pool,
  workspace: string,
  actor: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      "select set_config('app.workspace_id',$1,true), set_config('app.actor_id',$2,true)",
      [workspace, actor],
    );
    return await operation(client);
  } finally {
    try {
      await client.query('rollback');
    } finally {
      client.release();
    }
  }
}
async function ownerQuery<
  Row extends Record<string, unknown> = Record<string, unknown>,
>(sql: string, values: unknown[] = []) {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(
      "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
      [workspaceId, actorId],
    );
    const result = await client.query<Row>(sql, values);
    await client.query('commit');
    return result;
  } finally {
    try {
      await client.query('rollback');
    } finally {
      client.release();
    }
  }
}
async function cleanup() {
  const failures: unknown[] = [];
  for (const resource of resources.splice(0).reverse()) {
    try {
      await resource.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (created) {
    try {
      if (owned === undefined)
        throw new Error('Curated boundary ownership missing');
      await recheckCuratedFixtureOwnership(owned);
      await fixture.drop();
      created = false;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'Owned F06 boundary fixture cleanup failed',
    );
}

describe.skipIf(!enabled)(
  'owned PostgreSQL template-origin metadata boundaries (owner-seeded origin; writer on)',
  () => {
    beforeAll(async () => {
      try {
        await fixture.create();
        created = true;
        // Installed only in this disposable fixture. Seeded metadata does not
        // replace genuine creation, typed guard or live execution qualification.
        await migrateDatabase(createArtifactMigrationConfig(migrationUrl));
        ownerPool = new Pool({
          connectionString: migrationUrl,
          max: 3,
          connectionTimeoutMillis: 3000,
        });
        apiPool = new Pool({
          connectionString: apiUrl,
          max: 2,
          connectionTimeoutMillis: 3000,
        });
        workerPool = new Pool({
          connectionString: workerUrl,
          max: 1,
          connectionTimeoutMillis: 3000,
        });
        for (const pool of [ownerPool, apiPool, workerPool])
          resources.push({ close: () => pool.end() });
        identity = createIdentityWorkspaceDatabase(
          parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
        );
        resources.push(identity);
        authoring = createWorkflowAuthoringFixtureDatabase(
          parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
        );
        resources.push(authoring);
        for (const id of [actorId, otherActorId])
          await identity.createUser({
            id,
            email: `${id}@example.test`,
            displayName: 'Owned boundary fixture',
          });
        workspaceId = (
          await identity.createWorkspaceWithOwner({
            id: randomUUID(),
            name: 'F06 boundary',
            slug: `origin-${actorId}`,
            ownerUserId: actorId,
            idempotencyKey: randomUUID(),
          })
        ).id;
        otherWorkspaceId = (
          await identity.createWorkspaceWithOwner({
            id: randomUUID(),
            name: 'Other F06 boundary',
            slug: `origin-${otherActorId}`,
            ownerUserId: otherActorId,
            idempotencyKey: randomUUID(),
          })
        ).id;
        sourceId = (
          await authoring.createWorkflow({
            workspaceId,
            actorId,
            emptyGraph,
            name: 'Ordinary source, fixture-seeded origin',
            idempotencyKey: randomUUID(),
          })
        ).workflowId;
        otherSourceId = (
          await authoring.createWorkflow({
            workspaceId: otherWorkspaceId,
            actorId: otherActorId,
            emptyGraph,
            name: 'Other ordinary source',
            idempotencyKey: randomUUID(),
          })
        ).workflowId;
        for (const [workspace, workflow] of [
          [workspaceId, sourceId],
          [otherWorkspaceId, otherSourceId],
        ])
          await ownerQuery(
            'insert into app.workflow_template_origins(workspace_id,workflow_id,origin) values($1,$2,$3::jsonb)',
            [workspace, workflow, JSON.stringify(seededOrigin)],
          );
      } catch (error) {
        try {
          await cleanup();
        } catch (failure) {
          throw new AggregateError(
            [error, failure],
            'F06 setup and cleanup failed',
          );
        }
        throw error;
      }
    }, 120_000);
    afterAll(cleanup, 30_000);

    it('requires the current head and preserved 0133 inventory on API and worker; is not an old-image cutover proof', async () => {
      expect(EXPECTED_MIGRATION_HEAD).toBe('0000_baseline.sql');
      expect(
        (
          await apiPool.query(
            'select name from pertexo_internal.schema_migrations order by name desc limit 1',
          )
        ).rows,
      ).toEqual([{ name: '0000_baseline.sql' }]);
      for (const pool of [apiPool, workerPool])
        await expect(checkDatabaseReadiness(pool)).resolves.toMatchObject({
          migrationHead: '0000_baseline.sql',
        });
    });

    it('preserves exact ordinary record/default-read shape and authoritatively projects retained fixture metadata', async () => {
      const ordinary = await authoring.getWorkflow(
        workspaceId,
        sourceId,
        actorId,
      );
      expect(Object.keys(ordinary ?? {}).sort()).toEqual(
        [
          'activationStatus',
          'createdAt',
          'createdBy',
          'id',
          'lifecycleRevision',
          'lifecycleStatus',
          'name',
          'nameRevision',
          'publishedVersionId',
          'updatedAt',
          'workspaceId',
        ].sort(),
      );
      expect(ordinary).not.toHaveProperty('templateOrigin');
      expect(
        await authoring.getWorkflowWithTemplateOrigin(
          workspaceId,
          sourceId,
          actorId,
        ),
      ).toEqual({ workflow: ordinary, templateOrigin: seededOrigin });
      const plain = await authoring.createWorkflow({
        workspaceId,
        actorId,
        emptyGraph,
        name: 'No origin',
        idempotencyKey: randomUUID(),
      });
      expect(
        await authoring.getWorkflowWithTemplateOrigin(
          workspaceId,
          plain.workflowId,
          actorId,
        ),
      ).toMatchObject({ templateOrigin: null });
      expect(
        (
          await ownerQuery<{ import_enabled: boolean }>(
            'select import_enabled from app.curated_template_rollout',
          )
        ).rows,
      ).toEqual([{ import_enabled: true }]);
    });

    it('forces tenant RLS, hides unscoped/other-workspace rows, and preserves not-found disclosure', async () => {
      expect(
        (
          await ownerQuery<{
            relrowsecurity: boolean;
            relforcerowsecurity: boolean;
          }>(
            "select relrowsecurity,relforcerowsecurity from pg_class where oid='app.workflow_template_origins'::regclass",
          )
        ).rows,
      ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
      expect(
        (await apiPool.query('select * from app.workflow_template_origins'))
          .rows,
      ).toEqual([]);
      const rows = await scoped(apiPool, workspaceId, actorId, (client) =>
        client.query(
          'select workflow_id from app.workflow_template_origins order by workflow_id',
        ),
      );
      expect(rows.rows).toEqual([{ workflow_id: sourceId }]);
      expect(
        await authoring.getWorkflowWithTemplateOrigin(
          workspaceId,
          otherSourceId,
          actorId,
        ),
      ).toBeNull();
      expect(
        await authoring.getWorkflowWithTemplateOrigin(
          otherWorkspaceId,
          sourceId,
          otherActorId,
        ),
      ).toBeNull();
      await expect(
        authoring.getWorkflowWithTemplateOrigin(
          otherWorkspaceId,
          otherSourceId,
          actorId,
        ),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
      await expect(
        ownerQuery(
          'insert into app.workflow_template_origins(workspace_id,workflow_id,origin) values($1,$2,$3::jsonb)',
          [otherWorkspaceId, sourceId, JSON.stringify(seededOrigin)],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it.each([
      [
        'insert origin',
        'insert into app.workflow_template_origins(workspace_id,workflow_id,origin) values($1,$2,$3::jsonb)',
      ],
      [
        'update origin',
        'update app.workflow_template_origins set origin=origin where workspace_id=$1',
      ],
      [
        'delete origin',
        'delete from app.workflow_template_origins where workspace_id=$1',
      ],
      [
        'update descriptor content',
        "update app.curated_template_descriptors set supported_profile='validate_activation' where template_id=$1",
      ],
      [
        'update selection',
        'update app.curated_template_descriptors set selection_enabled=false where template_id=$1',
      ],
      [
        'delete descriptor',
        'delete from app.curated_template_descriptors where template_id=$1',
      ],
      [
        'insert descriptor',
        'insert into app.curated_template_descriptors select * from app.curated_template_descriptors where template_id=$1',
      ],
    ])(
      'denies API runtime %s without granting content/selection mutation',
      async (label, sql) => {
        // Evaluate fixture IDs after beforeAll, never module-time empty strings.
        const values =
          label === 'insert origin'
            ? [workspaceId, sourceId, JSON.stringify(seededOrigin)]
            : sql.includes('workflow_template_origins')
              ? [workspaceId]
              : [seededOrigin.templateId];
        await expect(
          scoped(apiPool, workspaceId, actorId, (client) =>
            client.query(sql, values),
          ),
        ).rejects.toMatchObject({ code: '42501' });
      },
    );

    it('confines descriptor helper execution and denies absent authority/worker execution', async () => {
      await expect(
        workerPool.query('select app.lock_curated_template_descriptor($1,1)', [
          seededOrigin.templateId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        apiPool.query('select app.lock_curated_template_descriptor($1,1)', [
          seededOrigin.templateId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        scoped(apiPool, workspaceId, actorId, (client) =>
          client.query('select app.lock_curated_template_descriptor($1,1)', [
            'x'.repeat(65),
          ]),
        ),
      ).rejects.toMatchObject({ code: '22023' });
      const result = await scoped(apiPool, workspaceId, actorId, (client) =>
        client.query(
          'select app.lock_curated_template_descriptor($1,1) descriptor',
          [seededOrigin.templateId],
        ),
      );
      expect(result.rows[0]).toMatchObject({
        descriptor: {
          templateId: seededOrigin.templateId,
          baseManifestDigest: seededOrigin.baseManifestDigest,
        },
      });
    });

    it('owner immutable-content trigger rejects content changes and deletion', async () => {
      await expect(
        ownerQuery(
          'update app.curated_template_descriptors set schema_version=2 where template_id=$1',
          [seededOrigin.templateId],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        message: 'curated descriptor content is immutable',
      });
      await expect(
        ownerQuery(
          'delete from app.curated_template_descriptors where template_id=$1',
          [seededOrigin.templateId],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        message: 'curated descriptor content is immutable',
      });
    });

    it('confined descriptor SHARE lock blocks owner retirement until caller transaction ends', async () => {
      const reader = await apiPool.connect(),
        writer = await ownerPool.connect();
      let retirement: Promise<unknown> | undefined;
      try {
        await reader.query('begin');
        await reader.query(
          "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
          [workspaceId, actorId],
        );
        const readerPid = (
          await reader.query<{ pid: number }>('select pg_backend_pid() pid')
        ).rows[0]?.pid;
        await reader.query(
          'select app.lock_curated_template_descriptor($1,1)',
          [seededOrigin.templateId],
        );
        await writer.query('begin');
        await writer.query('set local role pertexo_owner');
        await writer.query("set local lock_timeout='4s'");
        await writer.query("set local statement_timeout='5s'");
        const writerPid = (
          await writer.query<{ pid: number }>('select pg_backend_pid() pid')
        ).rows[0]?.pid;
        retirement = writer.query(
          'update app.curated_template_descriptors set selection_enabled=false where template_id=$1',
          [seededOrigin.templateId],
        );
        // Observe PostgreSQL's actual blocker, not an elapsed-time assertion.
        const deadline = Date.now() + 2000;
        let blocked = false;
        while (Date.now() < deadline && !blocked) {
          blocked =
            (
              await ownerPool.query<{ blocked: boolean }>(
                'select $1::int=any(pg_blocking_pids($2::int)) blocked',
                [readerPid, writerPid],
              )
            ).rows[0]?.blocked === true;
          if (!blocked) await ownerPool.query('select pg_sleep(0.01)');
        }
        expect(blocked).toBe(true);
        await reader.query('rollback');
        await retirement;
        await writer.query('commit');
        expect(
          (
            await ownerQuery(
              'select selection_enabled from app.curated_template_descriptors where template_id=$1',
              [seededOrigin.templateId],
            )
          ).rows,
        ).toEqual([{ selection_enabled: false }]);
      } finally {
        try {
          await reader.query('rollback');
        } finally {
          reader.release();
        }
        try {
          await retirement?.catch(() => undefined);
          await writer.query('rollback');
        } finally {
          writer.release();
        }
        await ownerQuery(
          'update app.curated_template_descriptors set selection_enabled=true where template_id=$1',
          [seededOrigin.templateId],
        );
      }
    }, 10_000);

    it('inherits owner-seeded historical origin under ordinary duplication with writer on and selection removed', async () => {
      await ownerQuery(
        'update app.curated_template_descriptors set selection_enabled=false where template_id=$1',
        [seededOrigin.templateId],
      );
      try {
        const draft = await authoring.getDraft(workspaceId, sourceId, actorId);
        if (draft === null)
          throw new Error('Ordinary source draft is unavailable');
        const input = {
          workspaceId,
          actorId,
          workflowId: sourceId,
          name: 'Inherited fixture basis',
          source: { kind: 'draft' as const },
          idempotencyKey: randomUUID(),
          representationTag: workflowDraftRepresentationTag({
            workflowId: sourceId,
            revision: draft.revision,
            graph: draft.graphJson,
            compatibilityFingerprint: draft.compatibility.fingerprint,
          }),
        };
        const copy = await authoring.duplicateWorkflow(input);
        expect(await authoring.duplicateWorkflow(input)).toEqual(copy);
        expect(copy.workflowId).not.toBe(sourceId);
        expect(
          await authoring.getWorkflowWithTemplateOrigin(
            workspaceId,
            copy.workflowId,
            actorId,
          ),
        ).toMatchObject({
          templateOrigin: { ...seededOrigin, derivation: 'inherited' },
        });
        expect(
          await authoring.getWorkflowWithTemplateOrigin(
            workspaceId,
            sourceId,
            actorId,
          ),
        ).toMatchObject({ templateOrigin: seededOrigin });
        expect(
          (
            await ownerQuery(
              'select import_enabled from app.curated_template_rollout',
            )
          ).rows,
        ).toEqual([{ import_enabled: true }]);
      } finally {
        await ownerQuery(
          'update app.curated_template_descriptors set selection_enabled=true where template_id=$1',
          [seededOrigin.templateId],
        );
      }
    });

    it('membership loss denies the scoped reader while shared fixture metadata remains stored', async () => {
      const membershipChange = await ownerQuery(
        "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
      );
      expect(membershipChange.rowCount).toBe(1);
      try {
        await expect(
          authoring.getWorkflowWithTemplateOrigin(
            workspaceId,
            sourceId,
            actorId,
          ),
        ).rejects.toBeInstanceOf(WorkflowNotFoundError);
        expect(
          (
            await ownerQuery(
              'select origin from app.workflow_template_origins where workspace_id=$1 and workflow_id=$2',
              [workspaceId, sourceId],
            )
          ).rows,
        ).toEqual([{ origin: seededOrigin }]);
      } finally {
        await ownerQuery(
          "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
          [workspaceId, actorId],
        );
      }
    });

    it('cascades only the exact owner-deleted workflow fixture child; does not claim retention/purge qualification', async () => {
      const doomed = await authoring.createWorkflow({
        workspaceId,
        actorId,
        emptyGraph,
        name: 'Exact cascade fixture',
        idempotencyKey: randomUUID(),
      });
      await ownerQuery(
        'insert into app.workflow_template_origins(workspace_id,workflow_id,origin) values($1,$2,$3::jsonb)',
        [workspaceId, doomed.workflowId, JSON.stringify(seededOrigin)],
      );
      const deleted = await ownerQuery(
        'delete from app.workflows where workspace_id=$1 and id=$2',
        [workspaceId, doomed.workflowId],
      );
      expect(deleted.rowCount).toBe(1);
      expect(
        (
          await ownerQuery(
            'select origin from app.workflow_template_origins where workspace_id=$1 and workflow_id=$2',
            [workspaceId, doomed.workflowId],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await ownerQuery(
            'select origin from app.workflow_template_origins where workspace_id=$1 and workflow_id=$2',
            [workspaceId, sourceId],
          )
        ).rows,
      ).toEqual([{ origin: seededOrigin }]);
    });
  },
);
