import {
  runErrorWorkflowIntents,
  workflows,
  databaseSchema,
} from '@pertexo/database/schema';
import { and, eq, lte, sql } from 'drizzle-orm';
import {
  rethrowQueryFailure,
  parseWorkspaceId,
} from '@pertexo/database/primitives';
import { WorkflowAlreadyRunningError } from '../commands/acceptance/errors.js';
import { recordWorkflowTriggerSkip } from '../../triggers/skips.repository.js';
import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  isWorkflowErrorTarget,
  workflowErrorInputSchema,
  CallableInputInvalidError,
  canonicalJson,
} from '@pertexo/workflow-model';
import {
  acceptWorkflowRun,
  prepareWorkflowRunAcceptance,
} from '../commands/acceptance.repository.js';
import {
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '../commands/acceptance/errors.js';
import { findPublishedWorkflow } from '../queries/execution/published.queries.js';
import type { InitialCheckpointFactory } from '../commands/initial-checkpoint.js';
import {
  ErrorWorkflowDeliveryMismatchError,
  ErrorWorkflowVersionUnavailableError,
} from './errors.js';
import type { ErrorWorkflowDeliveryInput } from './contract.js';
import { deferErrorWorkflowForQueue } from './queue-wait.repository.js';

export async function acceptErrorWorkflow(
  client: PoolClient,
  input: ErrorWorkflowDeliveryInput,
  prepare: InitialCheckpointFactory,
): Promise<void> {
  const db = drizzle(client);
  const selected = await lockErrorWorkflowIntent(client, input);
  if (selected === undefined) return;
  const { candidate, target, row } = selected;
  if (row.outbox_event_id !== input.outboxEventId)
    throw new ErrorWorkflowDeliveryMismatchError();
  if (row.status !== 'pending') return;
  const refuse = (code: RefusalCode) =>
    refuseErrorWorkflow(client, input, code);
  if (target[0]?.lifecycle_status !== 'active') {
    await refuse('target_unavailable');
    return;
  }
  // Keep the capacity fence outside the savepoint: a refusal and its deferred
  // wakeup must commit before a releasing run can observe the pending intent.
  await db
    .execute(
      sql`select app.lock_workspace_execution_counter(${input.workspaceId})`,
    )
    .catch(rethrowQueryFailure);
  if (
    row.queue_wait_expires_at !== null &&
    (
      await db
        .select({ one: sql`1` })
        .from(runErrorWorkflowIntents)
        .where(
          and(
            eq(runErrorWorkflowIntents.workspaceId, input.workspaceId),
            eq(runErrorWorkflowIntents.sourceRunId, input.sourceRunId),
            lte(
              runErrorWorkflowIntents.queueWaitExpiresAt,
              sql`clock_timestamp()`,
            ),
          ),
        )
        .catch(rethrowQueryFailure)
    ).length === 1
  ) {
    await refuse('queue_full');
    return;
  }
  const projection = await findPublishedWorkflow(db, {
    workspaceId: input.workspaceId,
    workflowId: candidate.target_workflow_id,
    id: candidate.target_version_id,
  }).catch(rethrowQueryFailure);
  if (projection === null) {
    await refuse('target_unavailable');
    return;
  }
  // A newer publication may have removed the trigger since Settings was saved.
  const envelope = z
    .object({ graph: z.unknown() })
    .parse(projection.executableJson);
  if (!isWorkflowErrorTarget(envelope.graph)) {
    await refuse('invalid_target');
    return;
  }
  await db
    .execute(sql`savepoint error_workflow_admission`)
    .catch(rethrowQueryFailure);
  try {
    const summary = workflowErrorInputSchema.parse(row.context);
    const initial = prepare(projection);
    const transaction = {
      db: drizzle(client, { schema: databaseSchema }),
      workspaceId: parseWorkspaceId(input.workspaceId),
    };
    const prepared = await prepareWorkflowRunAcceptance(
      transaction,
      candidate.target_workflow_id,
    );
    const digest = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    const accepted = await acceptWorkflowRun(
      transaction,
      {
        initialCheckpoint: initial.checkpoint,
        ...(initial.validateInput === undefined
          ? {}
          : { validateInput: initial.validateInput }),
        operation: 'workflow.run.accept',
        scope: `workflow-error:${input.sourceRunId}`,
        keyHash: digest(input.sourceRunId),
        requestHash: digest(
          `${input.sourceRunId}:${projection.id}:${canonicalJson(summary)}`,
        ),
        workflowId: candidate.target_workflow_id,
        workflowVersionId: projection.id,
        triggerType: 'workflow_error',
        runInput: summary,
        ...(input.traceparent === undefined
          ? {}
          : { traceparent: input.traceparent }),
      },
      prepared,
    );
    await db
      .update(runErrorWorkflowIntents)
      .set({
        status: 'accepted',
        acceptedRunId: accepted.runId,
        completedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(runErrorWorkflowIntents.workspaceId, input.workspaceId),
          eq(runErrorWorkflowIntents.sourceRunId, input.sourceRunId),
        ),
      )
      .catch(rethrowQueryFailure);
    await db
      .execute(sql`release savepoint error_workflow_admission`)
      .catch(rethrowQueryFailure);
  } catch (error) {
    const reason = errorWorkflowRefusal(error);
    if (reason === undefined) throw error;
    await db
      .execute(sql`rollback to savepoint error_workflow_admission`)
      .catch(rethrowQueryFailure);
    await db
      .execute(sql`release savepoint error_workflow_admission`)
      .catch(rethrowQueryFailure);
    if (
      reason === 'queue_full' &&
      (await deferErrorWorkflowForQueue(client, input))
    )
      return;
    if (reason === 'concurrency_limit')
      await recordWorkflowTriggerSkip(
        {
          db: drizzle(client, { schema: databaseSchema }),
          workspaceId: parseWorkspaceId(input.workspaceId),
        },
        candidate.target_workflow_id,
        'workflow_error',
      );
    await refuse(reason);
  }
}

type RefusalCode = NonNullable<
  (typeof runErrorWorkflowIntents.$inferSelect)['refusalCode']
>;
function errorWorkflowRefusal(error: unknown): RefusalCode | undefined {
  if (error instanceof WorkflowAlreadyRunningError) {
    return 'concurrency_limit';
  }
  if (error instanceof WorkspaceRunQuotaExceededError) {
    return 'queue_full';
  }
  if (error instanceof WorkspaceRunAdmissionDeniedError) {
    return 'workspace_unavailable';
  }
  if (
    error instanceof ErrorWorkflowVersionUnavailableError ||
    error instanceof CallableInputInvalidError
  ) {
    return 'invalid_target';
  }
  return undefined;
}

async function lockErrorWorkflowIntent(
  client: PoolClient,
  input: ErrorWorkflowDeliveryInput,
) {
  const db = drizzle(client);
  const [candidate] = await db
    .select({
      target_workflow_id: runErrorWorkflowIntents.targetWorkflowId,
      target_version_id: runErrorWorkflowIntents.targetVersionId,
    })
    .from(runErrorWorkflowIntents)
    .where(
      and(
        eq(runErrorWorkflowIntents.workspaceId, input.workspaceId),
        eq(runErrorWorkflowIntents.sourceRunId, input.sourceRunId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (candidate === undefined) return undefined;
  const target = await db
    .select({ lifecycle_status: workflows.lifecycleStatus })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, candidate.target_workflow_id),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  const [row] = await db
    .select({
      status: runErrorWorkflowIntents.status,
      context: runErrorWorkflowIntents.context,
      outbox_event_id: runErrorWorkflowIntents.outboxEventId,
      queue_wait_expires_at: runErrorWorkflowIntents.queueWaitExpiresAt,
    })
    .from(runErrorWorkflowIntents)
    .where(
      and(
        eq(runErrorWorkflowIntents.workspaceId, input.workspaceId),
        eq(runErrorWorkflowIntents.sourceRunId, input.sourceRunId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (row === undefined) return undefined;
  return { candidate, target, row };
}

async function refuseErrorWorkflow(
  client: PoolClient,
  input: ErrorWorkflowDeliveryInput,
  code: RefusalCode,
): Promise<void> {
  const db = drizzle(client);

  await db
    .update(runErrorWorkflowIntents)
    .set({
      status: 'refused',
      refusalCode: code,
      completedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(runErrorWorkflowIntents.workspaceId, input.workspaceId),
        eq(runErrorWorkflowIntents.sourceRunId, input.sourceRunId),
      ),
    )
    .catch(rethrowQueryFailure);
}
