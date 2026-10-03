import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  verifyCuratedFixtureOwnership,
  recheckCuratedFixtureOwnership,
} from '../../../infrastructure/testing/curated-template-owned-fixture.mjs';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';
import {
  copyMigrationsBefore,
  createArtifactMigrationConfig,
} from './support/artifact-migration-fixture.js';
import { migrateDatabase } from '../src/migrations.js';
import { parseDatabaseConfig } from '../src/config.js';
import { createIdentityWorkspaceDatabase } from '../src/tenant-access/identity-workspace.js';
import { createWorkflowAuthoringDatabase } from '../src/authoring/workflow-authoring.js';
import { checkDatabaseReadiness } from '../src/platform/readiness.js';
import { Pool } from 'pg';

describe('owned retained draft migration', () => {
  it('upgrades through the normal runner without changing prior ordinary drafts', async () => {
    const ownership = await verifyCuratedFixtureOwnership();
    const fixture = createDisposableDatabaseFixture({
      adminUrl: ownership.adminUrl,
      databaseName: `pertexo_test_f08_draft_${randomUUID().replaceAll('-', '')}`,
      ownerRole: 'pertexo_owner',
      connectRoles: ['pertexo_migration', 'pertexo_api', 'pertexo_worker'],
    });
    const prior = await mkdtemp(path.join(tmpdir(), 'pertexo-draft-prior-'));
    const config = parseDatabaseConfig({
      connectionString: fixture.databaseUrl(ownership.apiUrl),
      max: 1,
    });
    const identity = createIdentityWorkspaceDatabase(config);
    const authoring = createWorkflowAuthoringDatabase(config);
    const pool = new Pool({
      connectionString: fixture.databaseUrl(ownership.apiUrl),
      max: 1,
    });
    let created = false;
    try {
      await fixture.create();
      created = true;
      await copyMigrationsBefore(prior, '0136_');
      const migration = createArtifactMigrationConfig(
        fixture.databaseUrl(ownership.migrationUrl),
      );
      expect((await migrateDatabase(migration, prior)).at(-1)).toBe(
        '0135_workflow_folders_batch_identity.sql',
      );
      const actorId = randomUUID();
      await identity.createUser({
        id: actorId,
        email: `${actorId}@example.test`,
        displayName: 'Draft author',
      });
      const workspace = await identity.createWorkspaceWithOwner({
        name: 'Retained drafts',
        slug: `draft-${actorId}`,
        ownerUserId: actorId,
        idempotencyKey: randomUUID(),
      });
      const workflow = await authoring.createWorkflow({
        workspaceId: workspace.id,
        actorId,
        name: 'Before Graph2 storage',
        idempotencyKey: randomUUID(),
        emptyGraph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
      });
      const before = await authoring.getDraft(
        workspace.id,
        workflow.workflowId,
        actorId,
      );
      expect(await migrateDatabase(migration)).toEqual([
        '0136_workflow_draft_graph_v2.sql',
      ]);
      expect(
        await authoring.getDraft(workspace.id, workflow.workflowId, actorId),
      ).toEqual(before);
      expect(await checkDatabaseReadiness(pool)).toMatchObject({
        migrationHead: '0136_workflow_draft_graph_v2.sql',
      });
      await recheckCuratedFixtureOwnership(ownership);
    } finally {
      const closed = await Promise.allSettled([
        identity.close(),
        authoring.close(),
        pool.end(),
      ]);
      try {
        if (created) {
          await recheckCuratedFixtureOwnership(ownership);
          await fixture.drop();
        }
      } finally {
        await rm(prior, { recursive: true, force: true });
      }
      expect(closed.filter((result) => result.status === 'rejected')).toEqual(
        [],
      );
    }
  });
});
