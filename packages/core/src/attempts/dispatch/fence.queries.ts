import type { ExecutionCapabilityScope } from './contract.js';
import { ExecutionCapabilityExpiredError } from '../errors.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaces,
  nodeRuns,
  nodeAttempts,
  workflowRuns,
  previewRuns,
  previewAttempts,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
export async function lockCapabilityExecution(
  client: PoolClient,
  input: ExecutionCapabilityScope,
): Promise<void> {
  const db = drizzle(client);
  const workspace = await db
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .for('share')
    .catch(rethrowQueryFailure);
  if (workspace[0]?.status !== 'active')
    throw new ExecutionCapabilityExpiredError('The workspace is not active.');
  if (input.previewRunId !== undefined) {
    if (input.previewRunId !== input.runId)
      throw new ExecutionCapabilityExpiredError();
    await db
      .select({ id: previewRuns.id })
      .from(previewRuns)
      .where(
        and(
          eq(previewRuns.workspaceId, input.workspaceId),
          eq(previewRuns.id, input.previewRunId),
        ),
      )
      .for('update')
      .catch(rethrowQueryFailure);
    await db
      .select({ id: previewAttempts.id })
      .from(previewAttempts)
      .where(
        and(
          eq(previewAttempts.workspaceId, input.workspaceId),
          eq(previewAttempts.id, input.attemptId),
        ),
      )
      .for('update')
      .catch(rethrowQueryFailure);
  } else {
    await db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.workspaceId, input.workspaceId),
          eq(workflowRuns.id, input.runId),
        ),
      )
      .for('update')
      .catch(rethrowQueryFailure);
    await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.workspaceId, input.workspaceId),
          eq(nodeRuns.id, input.nodeRunId),
        ),
      )
      .for('update')
      .catch(rethrowQueryFailure);
    await db
      .select({ id: nodeAttempts.id })
      .from(nodeAttempts)
      .where(
        and(
          eq(nodeAttempts.workspaceId, input.workspaceId),
          eq(nodeAttempts.id, input.attemptId),
        ),
      )
      .for('update')
      .catch(rethrowQueryFailure);
  }
}
export async function assertCapabilityExecution(
  client: PoolClient,
  input: ExecutionCapabilityScope,
  {
    requireDispatch = false,
  }: Readonly<{ requireDispatch?: boolean | undefined }> = {},
): Promise<void> {
  const db = drizzle(client);
  let valid: boolean | null | undefined;
  if (input.previewRunId !== undefined) {
    const found = await db
      .select({
        valid: sql<boolean>`(${previewAttempts.status}='running' and ${previewAttempts.leaseOwner}=${input.workerId} and ${previewAttempts.fenceToken}=${input.fenceToken} and ${previewAttempts.leaseExpiresAt}>clock_timestamp() and ${previewRuns.status}='running' and ${previewRuns.executionDeadlineAt}>clock_timestamp() and (not ${requireDispatch}::boolean or ${previewAttempts.dispatchMarkedAt} is not null))`,
      })
      .from(previewAttempts)
      .innerJoin(
        previewRuns,
        and(
          eq(previewRuns.workspaceId, previewAttempts.workspaceId),
          eq(previewRuns.id, previewAttempts.previewRunId),
        ),
      )
      .where(
        and(
          eq(previewAttempts.workspaceId, input.workspaceId),
          eq(previewAttempts.id, input.attemptId),
          eq(previewRuns.id, input.runId),
        ),
      )
      .catch(rethrowQueryFailure);
    valid = found[0]?.valid;
  } else {
    const found = await db
      .select({
        valid: sql<boolean>`(${nodeAttempts.status}='running' and ${nodeAttempts.leaseOwner}=${input.workerId} and ${nodeAttempts.fenceToken}=${input.fenceToken} and ${nodeAttempts.leaseExpiresAt}>clock_timestamp() and ${nodeRuns.currentAttemptId}=${nodeAttempts.id} and ${workflowRuns.status} in ('running','waiting') and ${workflowRuns.cancelRequestedAt} is null and (${workflowRuns.deadlineAt} is null or ${workflowRuns.deadlineAt}>clock_timestamp()) and (not ${requireDispatch}::boolean or ${nodeAttempts.dispatchMarkedAt} is not null))`,
      })
      .from(nodeAttempts)
      .innerJoin(
        nodeRuns,
        and(
          eq(nodeRuns.workspaceId, nodeAttempts.workspaceId),
          eq(nodeRuns.id, nodeAttempts.nodeRunId),
        ),
      )
      .innerJoin(
        workflowRuns,
        and(
          eq(workflowRuns.workspaceId, nodeRuns.workspaceId),
          eq(workflowRuns.id, nodeRuns.workflowRunId),
        ),
      )
      .where(
        and(
          eq(nodeAttempts.workspaceId, input.workspaceId),
          eq(nodeAttempts.id, input.attemptId),
          eq(workflowRuns.id, input.runId),
          eq(nodeRuns.id, input.nodeRunId),
          eq(nodeRuns.nodeId, input.nodeId),
          eq(nodeRuns.invocationKey, input.invocationKey),
          eq(nodeAttempts.attemptNumber, input.attemptNumber),
        ),
      )
      .catch(rethrowQueryFailure);
    valid = found[0]?.valid;
  }
  if (!(valid ?? false)) throw new ExecutionCapabilityExpiredError();
}
