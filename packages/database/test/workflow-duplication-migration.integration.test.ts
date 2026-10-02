import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/graph';
import { parseDatabaseConfig } from '../src/config.js';
import { migrateDatabase } from '../src/migrations.js';
import { checkDatabaseReadiness } from '../src/platform/readiness.js';
import { createIdentityWorkspaceDatabase } from '../src/tenant-access/identity-workspace.js';
import { createWorkflowAuthoringFixtureDatabase } from './support/workflow-authoring-admission.fixture.js';
import {
  copyMigrationsBefore,
  createArtifactMigrationConfig,
} from './support/artifact-migration-fixture.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

describe('additive workflow duplication migration', () => {
  it('upgrades a populated 0128 database atomically, preserves ordinary authoring and enables runtime-role draft/version copies', async () => {
    const fixture = createDisposableDatabaseFixture({
      adminUrl:
        process.env.DATABASE_ADMIN_URL ??
        'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
      connectRoles: ['pertexo_migration', 'pertexo_api'],
      ownerRole: 'pertexo_owner',
      databaseName: `pertexo_test_duplicate_upgrade_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
    });
    const migrationUrl = fixture.databaseUrl(
      process.env.DATABASE_MIGRATION_URL ??
        'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
    );
    const apiUrl = fixture.databaseUrl(
      process.env.DATABASE_API_URL ??
        'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo',
    );
    const config = createArtifactMigrationConfig(migrationUrl);
    const priorDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-duplicate-upgrade-'),
    );
    const resources: { close(): Promise<void> }[] = [];
    let created = false,
      primaryError: unknown;
    try {
      await fixture.create();
      created = true;
      await copyMigrationsBefore(priorDirectory, '0129_');
      await migrateDatabase(config, priorDirectory);
      const identity = createIdentityWorkspaceDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      );
      resources.push(identity);
      const authoring = createWorkflowAuthoringFixtureDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      );
      resources.push(authoring);
      const pool = new Pool({ connectionString: apiUrl, max: 1 });
      resources.push({ close: () => pool.end() });
      const actorId = randomUUID();
      await identity.createUser({
        id: actorId,
        email: `${actorId}@example.test`,
        displayName: 'Upgrade author',
      });
      const workspace = await identity.createWorkspaceWithOwner({
        id: randomUUID(),
        name: 'Upgrade duplicate',
        slug: `duplicate-${actorId}`,
        ownerUserId: actorId,
        idempotencyKey: randomUUID(),
      });
      const graph = {
        schemaVersion: 1,
        nodes: [],
        edges: [],
        settings: { maxRunDurationMs: 1000 },
      };
      const source = await authoring.createWorkflow({
        actorId,
        workspaceId: workspace.id,
        name: 'Retained source',
        emptyGraph: graph,
        idempotencyKey: randomUUID(),
      });
      const draft = await authoring.getDraft(
        workspace.id,
        source.workflowId,
        actorId,
      );
      if (!draft) throw new Error('Expected predecessor draft');
      const tag = workflowDraftRepresentationTag({
        workflowId: source.workflowId,
        revision: draft.revision,
        graph: draft.graphJson,
        compatibilityFingerprint: draft.compatibility.fingerprint,
      });
      const version = await authoring.publishWorkflow({
        actorId,
        workspaceId: workspace.id,
        workflowId: source.workflowId,
        representationTag: tag,
        idempotencyKey: randomUUID(),
        requestHash: 'e'.repeat(64),
      });
      const input = {
        actorId,
        workspaceId: workspace.id,
        workflowId: source.workflowId,
        name: 'Upgraded copy',
        representationTag: tag,
        source: { kind: 'draft' as const },
        idempotencyKey: randomUUID(),
      };
      await expect(checkDatabaseReadiness(pool)).rejects.toThrow();
      await expect(authoring.duplicateWorkflow(input)).rejects.toMatchObject({
        code: '42883',
      });
      expect(
        await authoring.getDraft(workspace.id, source.workflowId, actorId),
      ).toEqual(draft);
      expect(await migrateDatabase(config)).toEqual([
        '0129_workflow_duplication.sql',
        '0130_workflow_input_cases.sql',
        '0131_checked_manual_start.sql',
        '0132_workflow_portability.sql',
        '0133_curated_template_origin.sql',
        '0134_workflow_organization.sql',
        '0135_workflow_folders_batch_identity.sql',
      ]);
      expect(await migrateDatabase(config)).toEqual([]);
      expect((await checkDatabaseReadiness(pool)).migrationHead).toBe(
        '0135_workflow_folders_batch_identity.sql',
      );
      const copied = await authoring.duplicateWorkflow(input);
      expect(await authoring.duplicateWorkflow(input)).toEqual(copied);
      expect(
        await authoring.getDraft(workspace.id, copied.workflowId, actorId),
      ).toMatchObject({ revision: 1, graphJson: graph });
      const versionCopy = await authoring.duplicateWorkflow({
        actorId,
        workspaceId: workspace.id,
        workflowId: source.workflowId,
        name: 'Retained version copy',
        source: { kind: 'version', versionId: version.version.id },
        idempotencyKey: randomUUID(),
      });
      expect(
        await authoring.getDraft(workspace.id, versionCopy.workflowId, actorId),
      ).toMatchObject({ revision: 1, graphJson: graph });
      expect(
        await authoring.getDraft(workspace.id, source.workflowId, actorId),
      ).toEqual(draft);
    } catch (error) {
      primaryError = error;
    }
    const failures: unknown[] = [];
    const settled = await Promise.allSettled(
      resources.reverse().map((resource) => resource.close()),
    );
    for (const result of settled)
      if (result.status === 'rejected') failures.push(result.reason);
    try {
      if (created) await fixture.drop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await rm(priorDirectory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (primaryError !== undefined) failures.unshift(primaryError);
    if (failures.length)
      throw new AggregateError(
        failures,
        'Duplication migration proof or cleanup failed',
      );
  });
});
