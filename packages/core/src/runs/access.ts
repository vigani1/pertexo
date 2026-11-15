import {
  UNPURGED_WORKSPACE_STATUSES,
  type WorkspaceStatusList,
} from '@pertexo/policy';
import type { Pool } from 'pg';
import { WorkspaceAccessDeniedError } from '../shared/workspace-access.errors.js';
import { readResourceTransaction } from '../shared/folder-access-facts.repository.js';
import {
  withWorkspaceAccess,
  type WorkspaceActor,
} from '../shared/workspace-access.js';
import { WorkflowRunNotFoundError } from './workflow-run.errors.js';
import type { ResourceTransaction } from '../shared/folder-access.types.js';
import {
  ownerVisible,
  runInScope,
  workflowInScope,
} from './run-access.repository.js';
import type { WorkflowResourceCapability } from '../shared/folder-access.types.js';

/** The command already holds the workspace authority fence before touching run rows. */
export async function requireRunAccess(
  transaction: ResourceTransaction,
  runId: string,
  capability: WorkflowResourceCapability,
): Promise<void> {
  if (!(await runInScope(transaction, runId, capability)))
    throw new WorkflowRunNotFoundError();
}

export async function requireWorkflowAccess(
  transaction: ResourceTransaction,
  workflowId: string,
  capability: WorkflowResourceCapability,
): Promise<void> {
  if (!(await workflowInScope(transaction, workflowId, capability)))
    throw new WorkflowRunNotFoundError();
}

/** A denial reads as not found, so a command can't tell an outsider a run exists. */
export async function withRunCommand<T>(
  pool: Pool,
  input: WorkspaceActor,
  access: Readonly<{
    capability: WorkflowResourceCapability;
    statuses: WorkspaceStatusList;
  }>,
  command: (transaction: ResourceTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await withWorkspaceAccess(
      pool,
      input,
      { mode: 'change', ...access },
      async (client, role) =>
        command(await readResourceTransaction(client, input, role)),
    );
  } catch (error) {
    if (error instanceof WorkspaceAccessDeniedError)
      throw new WorkflowRunNotFoundError();
    throw error;
  }
}

/**
 * Run history stays open until the purge starts. Each query filters by the folder
 * scope, so someone without access reads an empty page, not a denial.
 */
export function withRetainedRunRead<T>(
  pool: Pool,
  input: WorkspaceActor,
  read: (transaction: ResourceTransaction) => Promise<T>,
  statementTimeoutMillis?: number,
): Promise<T> {
  return withWorkspaceAccess(
    pool,
    input,
    {
      mode: 'visible',
      statuses: UNPURGED_WORKSPACE_STATUSES,
      statementTimeoutMillis,
    },
    async (client, role) =>
      read(await readResourceTransaction(client, input, role)),
  );
}

/** One visible owner gates all subsequent value reads in this same snapshot. */
function withResourceOwnerRead<T>(
  pool: Pool,
  input: WorkspaceActor,
  owner: Readonly<{ kind: 'workflow' | 'run'; id: string }>,
  read: (transaction: ResourceTransaction) => Promise<T>,
): Promise<T | undefined> {
  return withRetainedRunRead(pool, input, async (transaction) => {
    if (!(await ownerVisible(transaction, owner))) return undefined;
    return read(transaction);
  });
}

export function withResourceRunRead<T>(
  pool: Pool,
  input: WorkspaceActor & Readonly<{ runId: string }>,
  read: (transaction: ResourceTransaction) => Promise<T>,
): Promise<T | undefined> {
  return withResourceOwnerRead(
    pool,
    input,
    { kind: 'run', id: input.runId },
    read,
  );
}

export function withResourceWorkflowRead<T>(
  pool: Pool,
  input: WorkspaceActor & Readonly<{ workflowId: string }>,
  read: (transaction: ResourceTransaction) => Promise<T>,
): Promise<T | undefined> {
  return withResourceOwnerRead(
    pool,
    input,
    { kind: 'workflow', id: input.workflowId },
    read,
  );
}
