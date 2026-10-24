import { WorkflowAlreadyRunningError } from '../commands/concurrency.queries.js';
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
import { databaseSchema } from '../../schema.js';
import { parseWorkspaceId } from '../../tenant-access/transactions.js';
import {
  acceptWorkflowRun,
  prepareWorkflowRunAcceptance,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '../commands/acceptance.repository.js';
import { parsePublishedWorkflowRow } from '../queries/execution/published.queries.js';
import type { InitialCheckpointFactory } from '../commands/initial-checkpoint.js';
import {
  ErrorWorkflowDeliveryMismatchError,
  ErrorWorkflowVersionUnavailableError,
  type ErrorWorkflowDeliveryInput,
} from './contract.js';
import { deferErrorWorkflowForQueue } from './queue-wait.repository.js';

export async function acceptErrorWorkflow(
  client: PoolClient,
  input: ErrorWorkflowDeliveryInput,
  prepare: InitialCheckpointFactory,
): Promise<void> {
  const intent = await client.query<{
    target_workflow_id: string;
    target_version_id: string;
  }>(
    'select target_workflow_id,target_version_id from app.run_error_workflow_intents where workspace_id=$1 and source_run_id=$2',
    [input.workspaceId, input.sourceRunId],
  );
  const candidate = intent.rows[0];
  if (candidate === undefined) return;
  const target = await client.query<{ lifecycle_status: string }>(
    'select lifecycle_status from app.workflows where workspace_id=$1 and id=$2 for share',
    [input.workspaceId, candidate.target_workflow_id],
  );
  const locked = await client.query<{
    status: string;
    context: unknown;
    outbox_event_id: string;
    queue_wait_expires_at: Date | null;
  }>(
    'select status,context,outbox_event_id,queue_wait_expires_at from app.run_error_workflow_intents where workspace_id=$1 and source_run_id=$2 for update',
    [input.workspaceId, input.sourceRunId],
  );
  const row = locked.rows[0];
  if (row === undefined) return;
  if (row.outbox_event_id !== input.outboxEventId)
    throw new ErrorWorkflowDeliveryMismatchError();
  if (row.status !== 'pending') return;
  const refuse = async (code: string) => {
    await client.query(
      "update app.run_error_workflow_intents set status='refused',refusal_code=$3,completed_at=clock_timestamp() where workspace_id=$1 and source_run_id=$2",
      [input.workspaceId, input.sourceRunId, code],
    );
  };
  if (target.rows[0]?.lifecycle_status !== 'active') {
    await refuse('target_unavailable');
    return;
  }
  // Keep the capacity fence outside the savepoint: a refusal and its deferred
  // wakeup must commit before a releasing run can observe the pending intent.
  await client.query('select app.lock_workspace_execution_counter($1)', [
    input.workspaceId,
  ]);
  if (
    row.queue_wait_expires_at !== null &&
    (
      await client.query(
        'select 1 from app.run_error_workflow_intents where workspace_id=$1 and source_run_id=$2 and queue_wait_expires_at <= clock_timestamp()',
        [input.workspaceId, input.sourceRunId],
      )
    ).rowCount === 1
  ) {
    await refuse('queue_full');
    return;
  }
  const version = await client.query(
    'select id,workspace_id,workflow_id,version_number,checksum,executable_json from app.workflow_versions where workspace_id=$1 and workflow_id=$2 and id=$3',
    [
      input.workspaceId,
      candidate.target_workflow_id,
      candidate.target_version_id,
    ],
  );
  const projection = parsePublishedWorkflowRow(version.rows[0]);
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
  await client.query('savepoint error_workflow_admission');
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
          `${input.sourceRunId}:${candidate.target_version_id}:${canonicalJson(summary)}`,
        ),
        workflowId: candidate.target_workflow_id,
        workflowVersionId: candidate.target_version_id,
        triggerType: 'workflow_error',
        runInput: summary,
        ...(input.traceparent === undefined
          ? {}
          : { traceparent: input.traceparent }),
      },
      prepared,
    );
    await client.query(
      "update app.run_error_workflow_intents set status='accepted',accepted_run_id=$3,completed_at=clock_timestamp() where workspace_id=$1 and source_run_id=$2",
      [input.workspaceId, input.sourceRunId, accepted.runId],
    );
    await client.query('release savepoint error_workflow_admission');
  } catch (error) {
    const reason = errorWorkflowRefusal(error);
    if (reason === undefined) throw error;
    await client.query('rollback to savepoint error_workflow_admission');
    await client.query('release savepoint error_workflow_admission');
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

function errorWorkflowRefusal(error: unknown): string | undefined {
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
