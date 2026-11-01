import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { nodeRuns } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { serializeStoredExecutionJsonValue } from '../../values/stored-execution.js';
import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from '../../state-errors.js';
import type { RunTransitionPlan } from '../plan.js';

/** Source evidence and disposition share the checkpoint/admission transaction. */
export async function persistFailureHandling(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  plan: RunTransitionPlan,
): Promise<void> {
  for (const selection of plan.failureValues ?? []) {
    const source = plan.checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === selection.value.invocationKey,
    );
    if (source?.failureHandling?.disposition !== 'pending')
      throw new CoordinatorRunStateCorruptError();
    const written = await drizzle(client)
      .update(nodeRuns)
      .set({
        failureRef: sql`${serializeStoredExecutionJsonValue({ kind: 'inline', value: selection.value })}::json`,
        failureHandlerEntryKey: selection.entryInvocationKey,
        failureHandlerSinkKey: source.failureHandling.sinkInvocationKey,
        failureHandling: 'pending',
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(nodeRuns.workspaceId, workspaceId),
          eq(nodeRuns.workflowRunId, runId),
          eq(nodeRuns.invocationKey, selection.value.invocationKey),
          eq(nodeRuns.status, 'failed'),
          eq(nodeRuns.currentAttemptNumber, selection.value.attemptNumber),
          isNull(nodeRuns.failureRef),
        ),
      )
      .catch(rethrowQueryFailure);
    if (written.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
  for (const event of plan.events) {
    if (
      event.name !== 'node.failure_handled' ||
      event.invocationKey === undefined
    )
      continue;
    const source = plan.checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === event.invocationKey,
    );
    if (source?.failureHandling?.disposition !== 'handled')
      throw new CoordinatorRunStateCorruptError();
    const written = await drizzle(client)
      .update(nodeRuns)
      .set({ failureHandling: 'handled', updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(nodeRuns.workspaceId, workspaceId),
          eq(nodeRuns.workflowRunId, runId),
          eq(nodeRuns.invocationKey, event.invocationKey),
          eq(nodeRuns.status, 'failed'),
          eq(nodeRuns.failureHandling, 'pending'),
          eq(
            nodeRuns.failureHandlerSinkKey,
            source.failureHandling.sinkInvocationKey,
          ),
        ),
      )
      .catch(rethrowQueryFailure);
    if (written.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
}
