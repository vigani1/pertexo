import { readFolderScope } from '../../shared/facts.queries.js';
import type {
  FolderScope,
  WorkflowResourceCapability,
} from '../../shared/contract.js';
import {
  withWorkspaceAccess,
  type WorkspaceAccess,
  type WorkspaceActor,
} from '../../shared/workspace-access.js';
import { WorkspaceAccessDeniedError } from '../../shared/errors.js';
import { workflowAccessible } from '../../tenant-access/resources/workflows.queries.js';
import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type AuthorizationCapability,
  type Role,
  type WorkspaceStatusList,
} from '@pertexo/workflow-model';
import type { Pool, PoolClient } from 'pg';
import { WorkflowNotFoundError } from './errors.js';

export type WorkflowRef = Readonly<{
  workspaceId: string;
  workflowId: string;
}>;
export type WorkflowActor = WorkspaceActor & Readonly<{ workflowId: string }>;

/** Someone without access learns nothing: a denial reads as a missing workflow. */
function readAsNotVisible(error: unknown): never {
  if (error instanceof WorkspaceAccessDeniedError)
    throw new WorkflowNotFoundError('Workflow is not visible');
  throw error;
}

export async function requireWorkflowInScope(
  client: PoolClient,
  scope: FolderScope,
  workflow: WorkflowRef,
  capability: WorkflowResourceCapability,
): Promise<void> {
  if (!(await workflowAccessible(client, scope, { ...workflow, capability })))
    throw new WorkflowNotFoundError('Workflow is not visible');
}

export type AuthoringAccess = ReturnType<typeof createAuthoringAccess>;

/**
 * Authoring's doors onto `withWorkspaceAccess`. Every read here takes the share
 * locks too, so a workflow can't be read while its authority is being replaced.
 * Close waits for what's in flight, so no operation outlives the pool's lease.
 */
export function createAuthoringAccess(pool: Pool) {
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  async function tracked<T>(start: () => Promise<T>): Promise<T> {
    if (closed) throw new Error('Workflow authoring store is closed');
    const operation = start();
    pending.add(operation);
    try {
      return await operation;
    } finally {
      pending.delete(operation);
    }
  }
  function member<T>(
    actor: WorkspaceActor,
    access: WorkspaceAccess,
    work: (client: PoolClient, role: Role) => Promise<T>,
  ): Promise<T> {
    return tracked(() =>
      withWorkspaceAccess(pool, actor, access, work).catch(readAsNotVisible),
    );
  }
  function reader<T>(
    actor: WorkspaceActor,
    work: (client: PoolClient, scope: FolderScope) => Promise<T>,
  ): Promise<T> {
    return member(
      actor,
      {
        mode: 'change',
        capability: 'workflow:read',
        statuses: BROWSABLE_WORKSPACE_STATUSES,
      },
      async (client, role) =>
        work(client, await readFolderScope(client, actor, role)),
    );
  }
  function author<T>(
    actor: WorkspaceActor,
    work: (client: PoolClient, role: Role) => Promise<T>,
  ): Promise<T> {
    return member(
      actor,
      {
        mode: 'change',
        capability: 'workflow:update',
        statuses: ACTIVE_WORKSPACE_STATUSES,
      },
      work,
    );
  }
  /**
   * One workflow the actor's folders let them reach. `resource` differs from the
   * capability only for a flow that needs an editor who may merely read the
   * workflow, as duplicating does.
   */
  function workflow<T>(
    actor: WorkflowActor,
    {
      capability,
      resource,
      statuses = ACTIVE_WORKSPACE_STATUSES,
    }: Readonly<{
      capability: AuthorizationCapability & WorkflowResourceCapability;
      resource?: WorkflowResourceCapability;
      statuses?: WorkspaceStatusList;
    }>,
    work: (client: PoolClient, scope: FolderScope, role: Role) => Promise<T>,
  ): Promise<T> {
    return member(
      actor,
      { mode: 'change', capability, statuses },
      async (client, role) => {
        const scope = await readFolderScope(client, actor, role);
        await requireWorkflowInScope(
          client,
          scope,
          actor,
          resource ?? capability,
        );
        return work(client, scope, role);
      },
    );
  }
  return Object.freeze({
    tracked,
    reader,
    author,
    workflow,
    /** Refuses new work and settles what's in flight. */
    drain: () => {
      closed = true;
      return Promise.allSettled([...pending]);
    },
  });
}
