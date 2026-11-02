import { workflowRuns, workflows } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  ACTIVE_WORKSPACE_STATUSES,
  UNPURGED_WORKSPACE_STATUSES,
} from '@pertexo/workflow-model';
import type { Pool } from 'pg';
import { WorkspaceAccessDeniedError } from '../../shared/errors.js';
import { readResourceTransaction } from '../../shared/facts.queries.js';
import { withWorkspaceAccess } from '../../shared/workspace-access.js';
import type { ResourceActor } from '../../shared/contract.js';
import { and, eq, sql } from 'drizzle-orm';
import { WorkflowRunNotFoundError } from '../errors.js';
import type { ResourceTransaction } from '../../shared/contract.js';
import { workflowScopeSql } from '../../shared/scope.queries.js';
import type { WorkflowResourceCapability } from '../../shared/contract.js';

/** The command already holds the workspace authority fence before touching run rows. */
export async function requireRunAccess(
  transaction: ResourceTransaction,
  runId: string,
  capability: WorkflowResourceCapability,
): Promise<void> {
  const found = await transaction.db
    .select({ one: sql`1` })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, runId),
        workflowScopeSql(
          transaction.resources,
          sql`${workflowRuns.workflowId}`,
          capability,
        ),
      ),
    );
  if (found.length === 0) throw new WorkflowRunNotFoundError();
}

export async function requireWorkflowAccess(
  transaction: ResourceTransaction,
  workflowId: string,
  capability: WorkflowResourceCapability,
): Promise<void> {
  const found = await transaction.db
    .select({ one: sql`1` })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, transaction.workspaceId),
        eq(workflows.id, workflowId),
        workflowScopeSql(
          transaction.resources,
          sql`${workflows.id}`,
          capability,
        ),
      ),
    );
  if (found.length === 0) throw new WorkflowRunNotFoundError();
}

export async function withRunCommand<T>(
  pool: Pool,
  input: ResourceActor & { signal?: AbortSignal | undefined },
  capability: WorkflowResourceCapability,
  command: (transaction: ResourceTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await withWorkspaceAccess(
      pool,
      input,
      { mode: 'change', capability, statuses: ACTIVE_WORKSPACE_STATUSES },
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
  input: ResourceActor & Readonly<{ signal?: AbortSignal | undefined }>,
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
  input: ResourceActor & Readonly<{ signal?: AbortSignal | undefined }>,
  owner: Readonly<{ kind: 'workflow' | 'run'; id: string }>,
  read: (transaction: ResourceTransaction) => Promise<T>,
): Promise<T | undefined> {
  return withRetainedRunRead(pool, input, async (transaction) => {
    const source = owner.kind === 'run' ? workflowRuns : workflows;
    const workflowId =
      owner.kind === 'run' ? workflowRuns.workflowId : workflows.id;
    const visible = await transaction.db
      .select({ one: sql`1` })
      .from(source)
      .where(
        and(
          eq(source.workspaceId, transaction.workspaceId),
          eq(source.id, owner.id),
          workflowScopeSql(transaction.resources, sql`${workflowId}`),
        ),
      )
      .limit(1)
      .catch(rethrowQueryFailure);
    if (visible.length === 0) return undefined;
    return read(transaction);
  });
}

export function withResourceRunRead<T>(
  pool: Pool,
  input: ResourceActor &
    Readonly<{ runId: string; signal?: AbortSignal | undefined }>,
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
  input: ResourceActor &
    Readonly<{ workflowId: string; signal?: AbortSignal | undefined }>,
  read: (transaction: ResourceTransaction) => Promise<T>,
): Promise<T | undefined> {
  return withResourceOwnerRead(
    pool,
    input,
    { kind: 'workflow', id: input.workflowId },
    read,
  );
}
