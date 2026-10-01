import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { projectWorkflowPortableManifest } from '@pertexo/workflow-model/portability';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model/graph';
import { parseDatabaseConfig } from '../src/config.js';
import { migrateDatabase } from '../src/migrations.js';
import { checkDatabaseReadiness } from '../src/platform/readiness.js';
import { createIdentityWorkspaceDatabase } from '../src/tenant-access/identity-workspace.js';
import { WorkflowPortabilityUnavailableError } from '../src/authoring/workflow-authoring-errors.js';
import { createWorkflowAuthoringFixtureDatabase } from './support/workflow-authoring-admission.fixture.js';
import {
  copyMigrationsBefore,
  createArtifactMigrationConfig,
} from './support/artifact-migration-fixture.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';
import { BASELINE_COMPATIBILITY_EXPECTATION } from './baseline-compatibility-fixture.js';

describe('additive portable workflow migration', () => {
  it('upgrades populated exact0129 with default-off imports, unchanged stored authoring and pinned API/worker reader readiness', async () => {
    const fixture = createDisposableDatabaseFixture({
      adminUrl:
        process.env.DATABASE_ADMIN_URL ??
        'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
      connectRoles: ['pertexo_migration', 'pertexo_api', 'pertexo_worker'],
      ownerRole: 'pertexo_owner',
      databaseName: `pertexo_test_portable_upgrade_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
    });
    const migrationUrl = fixture.databaseUrl(
      process.env.DATABASE_MIGRATION_URL ??
        'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
    );
    const apiUrl = fixture.databaseUrl(
      process.env.DATABASE_API_URL ??
        'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo',
    );
    const workerUrl = fixture.databaseUrl(
      process.env.DATABASE_WORKER_URL ??
        'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo',
    );
    const config = createArtifactMigrationConfig(migrationUrl);
    const prior = await mkdtemp(
      path.join(tmpdir(), 'pertexo-portable-upgrade-'),
    );
    const resources: { close(): Promise<void> }[] = [];
    let created = false,
      primaryError: unknown;
    try {
      await fixture.create();
      created = true;
      await copyMigrationsBefore(prior, '0132_');
      await migrateDatabase(config, prior);
      const api = new Pool({ connectionString: apiUrl, max: 1 }),
        worker = new Pool({ connectionString: workerUrl, max: 1 });
      resources.push({ close: () => api.end() }, { close: () => worker.end() });
      const identity = createIdentityWorkspaceDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      );
      resources.push(identity);
      const portableCatalog = {
        fingerprint: BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
        definitions: [],
        selectionFingerprint: () => `node-select:v1:sha256:${'7'.repeat(64)}`,
      };
      const authoring = createWorkflowAuthoringFixtureDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
        {
          compatibilityRelease: BASELINE_COMPATIBILITY_EXPECTATION,
          definitionCatalog: {
            schemaVersion: 1,
            releaseFingerprint: portableCatalog.fingerprint,
            definitions: [],
          },
          portableCatalog,
        },
      );
      resources.push(authoring);
      const actorId = randomUUID();
      await identity.createUser({
        id: actorId,
        email: `${actorId}@example.test`,
        displayName: 'Portability upgrade author',
      });
      const workspace = await identity.createWorkspaceWithOwner({
        id: randomUUID(),
        name: 'Portability migration',
        slug: `portable-${actorId}`,
        ownerUserId: actorId,
        idempotencyKey: randomUUID(),
      });
      const graph = parseWorkflowGraphDraft({
        schemaVersion: 1,
        nodes: [],
        edges: [],
        settings: { maxRunDurationMs: 1000 },
      });
      const retained = await authoring.createWorkflow({
        workspaceId: workspace.id,
        actorId,
        name: 'Retained draft',
        emptyGraph: graph,
        idempotencyKey: randomUUID(),
      });
      const priorDraft = await authoring.getDraft(
        workspace.id,
        retained.workflowId,
        actorId,
      );
      const priorHead = await api.query(
        'select name from pertexo_internal.schema_migrations order by name desc limit 1',
      );
      expect(priorHead.rows).toEqual([
        { name: '0129_workflow_duplication.sql' },
      ]);
      await expect(checkDatabaseReadiness(api)).rejects.toThrow();
      expect(await migrateDatabase(config)).toEqual([
        '0132_workflow_portability.sql',
      ]);
      expect(await migrateDatabase(config)).toEqual([]);
      expect(
        await authoring.getDraft(workspace.id, retained.workflowId, actorId),
      ).toEqual(priorDraft);
      for (const role of [api, worker])
        expect((await checkDatabaseReadiness(role)).migrationHead).toBe(
          '0132_workflow_portability.sql',
        );
      expect(
        (
          await api.query(`select proname,md5(prosrc) digest from pg_proc where oid in (
        'app.lock_workflow_portable_version(uuid,uuid,uuid,uuid)'::regprocedure,
        'app.create_workflow_import_draft(uuid,uuid,uuid,jsonb,char,char,text)'::regprocedure) order by proname`)
        ).rows,
      ).toEqual([
        {
          proname: 'create_workflow_import_draft',
          digest: '6664b5e481156f7bd185447e5e9a8e17',
        },
        {
          proname: 'lock_workflow_portable_version',
          digest: '00c1b41bf997942d194f9af7819f4d15',
        },
      ]);
      const body = {
        workspaceId: workspace.id,
        actorId,
        manifest: projectWorkflowPortableManifest(graph, portableCatalog),
        bindings: [],
      };
      expect((await authoring.previewWorkflowImport(body)).compatible).toBe(
        true,
      );
      await expect(
        authoring.importWorkflow({
          ...body,
          name: 'New portable workflow',
          expectedCompatibilityFingerprint: portableCatalog.fingerprint,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(WorkflowPortabilityUnavailableError);
      expect(
        (
          await api.query(
            'select import_enabled from app.workflow_portability_rollout',
          )
        ).rows,
      ).toEqual([{ import_enabled: false }]);
      expect(
        (
          await api.query(
            "select has_table_privilege(current_user,'app.workflow_versions','UPDATE') mutable",
          )
        ).rows,
      ).toEqual([{ mutable: false }]);
    } catch (error) {
      primaryError = error;
    }
    const settled = await Promise.allSettled(
      resources.reverse().map((resource) => resource.close()),
    );
    const errors: unknown[] = settled.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    try {
      if (created) await fixture.drop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await rm(prior, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (primaryError !== undefined) errors.unshift(primaryError);
    if (errors.length > 0)
      throw new AggregateError(
        errors,
        'Portable migration proof or cleanup failed',
      );
  }, 30_000);
});
