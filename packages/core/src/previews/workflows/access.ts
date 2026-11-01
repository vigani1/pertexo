import type { Pool, PoolClient } from 'pg';
import {
  ACTIVE_WORKSPACE_STATUSES,
  hasCapability,
  rolesForCapability,
  type Role,
} from '@pertexo/workflow-model';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
import { lockWorkflowAuthoringAuthority } from '../../authoring/workflows/authority.js';
import { WorkflowNotFoundError } from '../../authoring/workflows/errors.js';
import { readFolderScope } from '../../shared/facts.queries.js';
import { withWorkspaceAccess } from '../../shared/workspace-access.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import type { WorkflowResourceCapability } from '../../tenant-access/resources/contract.js';
import { workflowAccessible } from '../../tenant-access/resources/workflows.queries.js';

const capabilities = ['workflow:update', 'run:read', 'run:start'] as const;
const testRoles = rolesForCapability('workflow:update').filter((role) =>
  capabilities.every((capability) =>
    rolesForCapability(capability).includes(role),
  ),
);
/** A read gives up rather than hold a request's connection. */
const TEST_READ_STATEMENT_TIMEOUT_MILLIS = 2_000;

function workflowNotVisible(): WorkflowNotFoundError {
  return new WorkflowNotFoundError('Workflow is not visible');
}

/** For the suite worker, which has no member behind it and treats a denial as a stop reason. */
export async function lockTestAuthority(
  client: PoolClient,
  input: SampleScope,
): Promise<void> {
  await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
    actorId: input.actorId,
    roles: testRoles,
    resource: { workflowId: input.workflowId, capability: 'workflow:update' },
  });
}

/**
 * Whoever started a test or suite can stop it. Stopping someone else's takes
 * `run:cancel`, answered like every other denial here. Real runs don't come
 * through this: `run:cancel` itself isn't wider.
 */
export function requireTestStopAuthority(
  role: Role,
  startedBy: string | null,
  actorId: string,
): void {
  if (startedBy !== actorId && !hasCapability(role, 'run:cancel'))
    throw workflowNotVisible();
}

async function requireVisibleWorkflow(
  client: PoolClient,
  input: SampleScope,
  role: Role,
  capability?: WorkflowResourceCapability,
): Promise<void> {
  if (!testRoles.includes(role)) throw workflowNotVisible();
  const access = await readFolderScope(client, input, role);
  const visible = await workflowAccessible(client, access, {
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    capability,
  });
  if (!visible) throw workflowNotVisible();
}

/** Someone without access sees "not found" rather than learning the workflow exists. */
async function hidingDenial<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof WorkspaceAccessDeniedError) throw workflowNotVisible();
    throw error;
  }
}

export function withTestChange<T>(
  pool: Pool,
  input: SampleScope,
  work: (client: PoolClient, role: Role) => Promise<T>,
): Promise<T> {
  return hidingDenial(() =>
    withWorkspaceAccess(
      pool,
      input,
      {
        mode: 'change',
        capability: 'workflow:update',
        statuses: ACTIVE_WORKSPACE_STATUSES,
      },
      async (client, role) => {
        await requireVisibleWorkflow(client, input, role, 'workflow:update');
        return work(client, role);
      },
    ),
  );
}

export function withTestRead<T>(
  pool: Pool,
  input: SampleScope,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return hidingDenial(() =>
    withWorkspaceAccess(
      pool,
      input,
      {
        mode: 'read',
        capability: 'workflow:update',
        statuses: ACTIVE_WORKSPACE_STATUSES,
        statementTimeoutMillis: TEST_READ_STATEMENT_TIMEOUT_MILLIS,
      },
      async (client, role) => {
        await requireVisibleWorkflow(client, input, role);
        return work(client);
      },
    ),
  );
}
