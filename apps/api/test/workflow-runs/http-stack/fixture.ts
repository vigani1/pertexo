import { runPersistenceSpies } from '../../support/run-ports.js';
import type { Role } from '@pertexo/workflow-model';

import type { ApiIdentityRuntime } from '../../../src/platform/identity/runtime.module.js';

import { createApiApplication } from '../../../src/app.js';
import {
  createApiPlatformFixture,
  createStubIdentityRuntime,
  createStubApiWorkflowRuntime,
} from '../../support/api-platform.fixture.js';

import type { WorkspaceStatus } from '../../../src/authorization/index.js';

export const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const workflowVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const rawSession = 's'.repeat(43);

const csrf = 'c'.repeat(32);

const { config, database, logger, rateLimitConsumer, telemetry } =
  createApiPlatformFixture('0021_workflow_integration_usage.sql');

function identityRuntime(
  role: Role = 'owner',
  workspaceStatus: WorkspaceStatus = 'active',
): ApiIdentityRuntime {
  return createStubIdentityRuntime(actorId, {
    findAccess: (query: Readonly<{ actorId: string; workspaceId: string }>) =>
      Promise.resolve(
        query.actorId === actorId && query.workspaceId === workspaceId
          ? {
              actorId,
              workspaceId,
              role,
              membershipStatus: 'active' as const,
              workspaceStatus,
            }
          : undefined,
      ),
  });
}

function persistenceFixture() {
  const persistence = runPersistenceSpies();
  return { persistence, ...persistence };
}

export const authHeaders = {
  cookie: `pertexo_session=${rawSession}; pertexo_csrf=${csrf}`,
};

export const mutationHeaders = {
  ...authHeaders,
  'x-csrf-token': csrf,
  'idempotency-key': 'workflow-run-http-stack',
};

const applicationFixture: {
  application: Awaited<ReturnType<typeof createApiApplication>> | undefined;
} = { application: undefined };

export async function start(
  role: Role = 'owner',
  workspaceStatus: WorkspaceStatus = 'active',
) {
  const identity = identityRuntime(role, workspaceStatus);
  const fixture = persistenceFixture();
  const baseRuntime = createStubApiWorkflowRuntime(
    identity.dependencies.authorization,
  );
  applicationFixture.application = await createApiApplication(config, {
    database,
    identityRuntime: identity,
    workflowRuntime: {
      ...baseRuntime,
      runDependencies: {
        authorization: identity.dependencies.authorization,
        persistence: fixture.persistence,
        streamer: baseRuntime.runDependencies.streamer,
      },
    },
    logger,
    rateLimitConsumer,
    telemetry,
  });
  await applicationFixture.application.init();
  return { application: applicationFixture.application, fixture };
}

export async function cleanWorkflowRunsRealNestHTTPStack() {
  await applicationFixture.application?.close();
  applicationFixture.application = undefined;
}
