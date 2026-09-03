import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import {
  PREVIEW_STATUS,
  sha256Schema,
  type PreviewStatus,
} from './preview-execution-acceptance.js';
import {
  PreviewAttemptStateError,
  optionsFor,
  previewConsumerName,
  safeErrorCodeSchema,
  type PreviewAttemptLease,
  type PreviewDelivery,
  type PreviewTerminalOutcome,
} from './preview-execution-contract.js';
import { completePreviewReceipt } from './preview-execution-delivery.js';
import { serializeStoredExecutionValueV1 } from './stored-execution-value.js';
import { withTenantScopedClient } from '../tenant-access/workspace.js';

export type PreviewCompletionResult = Readonly<{
  kind: 'committed' | 'duplicate';
}>;

export async function appendPreviewTerminalFacts(
  client: PoolClient,
  input: Readonly<{
    previewAttemptId: string;
    previewRunId: string;
    status: Exclude<PreviewStatus, 'queued' | 'running'>;
    workspaceId: string;
  }>,
): Promise<void> {
  const result = await client.query<{
    actor_user_id: string;
    definition_key: string;
    definition_version: number;
    executor_key: string;
    executor_version: number;
    dry_run: string;
    may_contact_provider: boolean;
    may_cause_external_side_effect: boolean;
    node_id: string;
    request_id: string | null;
    side_effect_class: string;
    trace_id: string | null;
    workflow_id: string;
  }>(
    `select actor_user_id,workflow_id,node_id,definition_key,
            definition_version,executor_key,executor_version,
            side_effect_class,may_contact_provider,
            may_cause_external_side_effect,dry_run,request_id,trace_id
       from app.preview_runs
      where workspace_id=$1 and id=$2`,
    [input.workspaceId, input.previewRunId],
  );
  const run = result.rows[0];
  if (run === undefined)
    throw new PreviewAttemptStateError('terminal_facts_run_missing');
  const metadata = {
    schemaVersion: 1,
    status: input.status,
    workflowId: run.workflow_id,
    nodeId: run.node_id,
    definitionKey: run.definition_key,
    definitionVersion: run.definition_version,
    executorKey: run.executor_key,
    executorVersion: run.executor_version,
    dryRun: run.dry_run,
    sideEffectClass: run.side_effect_class,
    mayContactProvider: run.may_contact_provider,
    mayCauseExternalSideEffect: run.may_cause_external_side_effect,
  } as const;
  await client.query(
    `insert into app.audit_events (
       id,workspace_id,actor_user_id,action,target_type,target_id,request_id,
       trace_id,metadata
     ) values ($1,$2,$3,'preview.execution_terminal','preview-run',$4,$5,$6,$7::jsonb)`,
    [
      uuidv7(),
      input.workspaceId,
      run.actor_user_id,
      input.previewRunId,
      run.request_id,
      run.trace_id,
      JSON.stringify({ ...metadata, previewAttemptId: input.previewAttemptId }),
    ],
  );
  await client.query(
    `insert into app.usage_events (
       id,workspace_id,category,quantity,resource_type,resource_id,
       idempotency_key,metadata
     ) values ($1,$2,'preview_execution',1,'preview-run',$3,$4,$5::jsonb)`,
    [
      uuidv7(),
      input.workspaceId,
      input.previewRunId,
      `preview-terminal:${input.previewRunId}`,
      JSON.stringify({
        schemaVersion: 1,
        status: input.status,
        definitionKey: run.definition_key,
        executorKey: run.executor_key,
        sideEffectClass: run.side_effect_class,
      }),
    ],
  );
}

export async function completePreviewAttempt(
  pool: Pool,
  input: Readonly<{
    delivery: PreviewDelivery;
    lease: Pick<
      PreviewAttemptLease,
      'attemptFenceToken' | 'previewAttemptId' | 'previewRunId' | 'workspaceId'
    >;
    outcome: PreviewTerminalOutcome;
    signal?: AbortSignal;
    workerId: string;
  }>,
): Promise<PreviewCompletionResult> {
  const scope = z
    .object({
      attemptFenceToken: z.number().int().nonnegative(),
      delivery: z.object({
        outboxEventId: z.uuid(),
        payloadChecksum: sha256Schema,
      }),
      previewAttemptId: z.uuid(),
      previewRunId: z.uuid(),
      workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
      workspaceId: z.uuid(),
    })
    .parse({
      ...input.lease,
      delivery: input.delivery,
      workerId: input.workerId,
    });
  const outcome =
    input.outcome.status === PREVIEW_STATUS.succeeded
      ? ({
          status: PREVIEW_STATUS.succeeded,
          outputRef: serializeStoredExecutionValueV1(input.outcome.output),
        } as const)
      : ({
          safeErrorCode: safeErrorCodeSchema.parse(input.outcome.safeErrorCode),
          status: input.outcome.status,
        } as const);
  return withTenantScopedClient(
    pool,
    { workspaceId: scope.workspaceId },
    async (client): Promise<PreviewCompletionResult> => {
      const terminal = await client.query<{ id: string }>(
        `update app.preview_attempts
         set status=$6::varchar,
             output_ref=$7::jsonb,
             safe_error_code=$8::varchar,
             completed_at=clock_timestamp(),
             lease_owner=null,
             lease_expires_at=null,
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and preview_run_id=$3
           and status='running' and lease_owner=$4 and fence_token=$5
         returning id`,
        [
          scope.workspaceId,
          scope.previewAttemptId,
          scope.previewRunId,
          scope.workerId,
          scope.attemptFenceToken,
          outcome.status,
          outcome.status === PREVIEW_STATUS.succeeded
            ? JSON.stringify(outcome.outputRef)
            : null,
          outcome.status === PREVIEW_STATUS.succeeded
            ? null
            : outcome.safeErrorCode,
        ],
      );
      if (terminal.rowCount !== 1) {
        const current = await client.query<{
          output_ref: unknown;
          status: string;
        }>(
          `select status,output_ref from app.preview_attempts
           where workspace_id=$1 and id=$2`,
          [scope.workspaceId, scope.previewAttemptId],
        );
        const row = current.rows[0];
        if (row === undefined)
          throw new PreviewAttemptStateError('completion_lost');
        if (
          row.status !== outcome.status ||
          (outcome.status === PREVIEW_STATUS.succeeded &&
            row.output_ref === null)
        )
          throw new PreviewAttemptStateError('completion_lost');
        return Object.freeze({ kind: 'duplicate' });
      }
      const syncedRuns = await client.query<{ id: string }>(
        `update app.preview_runs
         set status=$3::varchar,
             output_ref=$4::jsonb,
             safe_error_code=$5::varchar,
             completed_at=clock_timestamp(),
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2
           and status in ('queued','running')
         returning id`,
        [
          scope.workspaceId,
          scope.previewRunId,
          outcome.status,
          outcome.status === PREVIEW_STATUS.succeeded
            ? JSON.stringify(outcome.outputRef)
            : null,
          outcome.status === PREVIEW_STATUS.succeeded
            ? null
            : outcome.safeErrorCode,
        ],
      );
      if (syncedRuns.rowCount !== 1)
        throw new PreviewAttemptStateError('run_sync_lost');
      await appendPreviewTerminalFacts(client, {
        previewAttemptId: scope.previewAttemptId,
        previewRunId: scope.previewRunId,
        status: outcome.status,
        workspaceId: scope.workspaceId,
      });
      // The inbox receipt completes atomically with the truthful business
      // outcome, exactly like production attempt transitions.
      await completePreviewReceipt(
        client,
        previewConsumerName,
        scope.workspaceId,
        {
          outboxEventId: scope.delivery.outboxEventId,
          payloadChecksum: scope.delivery.payloadChecksum,
        },
      );
      return Object.freeze({ kind: 'committed' });
    },
    optionsFor(input.signal),
  );
}
