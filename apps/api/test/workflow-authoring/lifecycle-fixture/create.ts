import { randomUUID } from 'node:crypto';

import { createIdentityWorkspaceStore } from '@pertexo/core/testing';
import { createWorkspaceDatabase } from '@pertexo/database/testing';

import { createTestApiApplication } from '../../support/api-application.js';
import { createApiIdentityRuntime } from '../../../src/platform/identity/runtime.module.js';
import { Pool, type PoolClient } from 'pg';

import { issueBrowserSession } from '../../webhooks/support/browser-session.fixture.js';
import {
  FixtureResourceOwner,
  rethrowFixtureSetupFailure,
} from '../../browser/harness/resource-owner.js';

import {
  migrationUrl,
  workflowLifecycleDatabaseConfig,
} from './environment.js';
import type {
  LifecycleFixtureRole,
  WorkflowLifecycleApiFixture,
} from './contract.js';
import {
  logger,
  telemetry,
  apiConfig,
  requireIntegrationUrl,
  borrowedWorkspaceDatabase,
} from './settings.js';
import { resolveIdentity } from './http.js';
import {
  seedWorkflowRows,
  createForeignVersionWithOwner,
  setWorkspaceStatusWithOwner,
} from './seed.js';
import { readWorkflowHistory, readWorkflowLifecycle } from './read.js';
import {
  withOwnerClient,
  withApiClient,
  databaseUrl,
  databaseNameFromUrl,
} from './database.js';

export async function createWorkflowLifecycleApiFixture(): Promise<WorkflowLifecycleApiFixture> {
  const resources = new FixtureResourceOwner();
  try {
    const identityDatabase = resources.acquire(
      'identity database',
      createIdentityWorkspaceStore(workflowLifecycleDatabaseConfig),
      (database) => database.close(),
    );
    const identityConfig = apiConfig().identity;
    if (identityConfig === undefined)
      throw new Error('Workflow lifecycle identity configuration is missing');
    const identityRuntime = resources.acquire(
      'identity runtime',
      await createApiIdentityRuntime(
        identityConfig,
        workflowLifecycleDatabaseConfig,
      ),
      (runtime) => runtime.close(),
    );
    const workspaceDatabase = resources.acquire(
      'workspace database',
      createWorkspaceDatabase(workflowLifecycleDatabaseConfig),
      (database) => database.close(),
    );
    const subjects = {
      owner: await resolveIdentity(identityDatabase, 'owner'),
      builder: await resolveIdentity(identityDatabase, 'builder'),
      operator: await resolveIdentity(identityDatabase, 'operator'),
      viewer: await resolveIdentity(identityDatabase, 'viewer'),
    } as const;
    const workspaceId = randomUUID();
    const ids = {
      unpublished: randomUUID(),
      published: randomUUID(),
      publishedVersion: randomUUID(),
      run: randomUUID(),
    } as const;
    const ownerPool = resources.acquire(
      'owner pool',
      new Pool({
        connectionString: databaseUrl(
          requireIntegrationUrl(migrationUrl, 'DATABASE_MIGRATION_URL'),
          databaseNameFromUrl(),
        ),
        max: 1,
      }),
      (pool) => pool.end(),
    );
    const apiPool = resources.acquire(
      'API verification pool',
      new Pool({
        connectionString: workflowLifecycleDatabaseConfig.connectionString,
        max: 1,
      }),
      (pool) => pool.end(),
    );
    const withOwner = async <T>(
      work: (client: PoolClient) => Promise<T>,
    ): Promise<T> => withOwnerClient(ownerPool, workspaceId, work);
    const withApi = async <T>(
      work: (client: PoolClient) => Promise<T>,
    ): Promise<T> => withApiClient(apiPool, workspaceId, work);
    await withOwner(async (client) => {
      await client.query(
        `insert into app.workspaces
           (id,name,slug,status,created_by)
         values ($1,$2,$3,'active',$4)`,
        [
          workspaceId,
          'Workflow lifecycle proof',
          `workflow-lifecycle-${randomUUID().slice(0, 12)}`,
          subjects.owner.user.id,
        ],
      );
      await client.query(
        `insert into app.workspace_memberships
           (workspace_id,user_id,role,status)
         values
           ($1,$2,'owner','active'),
           ($1,$3,'builder','active'),
           ($1,$4,'operator','active'),
           ($1,$5,'viewer','active')`,
        [
          workspaceId,
          subjects.owner.user.id,
          subjects.builder.user.id,
          subjects.operator.user.id,
          subjects.viewer.user.id,
        ],
      );
      await seedWorkflowRows(client, workspaceId, subjects.owner.user.id, ids);
    });
    await withApi(async (client) => {
      await client.query(
        `insert into app.workflow_runs
           (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
         values ($1,$2,$3,$4,'manual','succeeded')`,
        [ids.run, workspaceId, ids.published, ids.publishedVersion],
      );
    });

    const application = resources.acquire(
      'API application',
      await createTestApiApplication(apiConfig(), {
        database: borrowedWorkspaceDatabase(workspaceDatabase),
        identityRuntime: {
          ...identityRuntime,
          close: () => Promise.resolve(),
        },
        rateLimitConsumer: {
          consume: () => Promise.resolve({ allowed: true as const }),
        },
        logger,
        telemetry,
      }),
      (app) => app.close(),
    );
    return Object.freeze({
      application,
      workspaceDatabase,
      identityDatabase,
      workspaceId,
      ownerUserId: subjects.owner.user.id,
      builderUserId: subjects.builder.user.id,
      operatorUserId: subjects.operator.user.id,
      viewerUserId: subjects.viewer.user.id,
      ids,
      login: (subject: LifecycleFixtureRole) =>
        issueBrowserSession(
          identityRuntime.dependencies.sessions,
          subjects[subject].user.id,
        ),
      withOwner,
      setWorkspaceStatus: (status) =>
        setWorkspaceStatusWithOwner(
          ownerPool,
          workspaceId,
          subjects.owner.user.id,
          status,
        ),
      readLifecycle: (workflowId) => readWorkflowLifecycle(withApi, workflowId),
      readHistory: (workflowId) => readWorkflowHistory(withApi, workflowId),
      createForeignVersion: () =>
        createForeignVersionWithOwner(ownerPool, subjects.owner.user.id),
      close: () => resources.close(),
    });
  } catch (error: unknown) {
    return await rethrowFixtureSetupFailure(resources, error);
  }
}

export async function closeWorkflowLifecycleApiFixture(
  fixture: WorkflowLifecycleApiFixture | undefined,
): Promise<void> {
  await fixture?.close();
}
