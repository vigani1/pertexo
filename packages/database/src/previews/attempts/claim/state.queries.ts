import { drizzle } from 'drizzle-orm/node-postgres';
import { readVariableSetValues } from '../../../variables/values.queries.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { executableNodeSchema } from '../../executable-node.js';

import {
  PreviewAttemptStateError,
  previewPairConsistent,
  type PreviewAttemptLease,
} from '../../contract.js';

import { parseStoredExecutionValue } from '../../../platform/stored-execution-value.js';
import type { withTenantScopedClient } from '../../../tenant-access/transactions.js';

export async function loadPreviewLease(
  client: Parameters<Parameters<typeof withTenantScopedClient>[2]>[0],
  input: Readonly<{
    attemptFenceToken: number;
    previewAttemptId: string;
    previewRunId: string;
    workspaceId: string;
  }>,
): Promise<PreviewAttemptLease> {
  const runs = await client.query<
    Readonly<{
      definition_key: string;
      definition_version: number;
      dry_run: string;
      executable_node_json: unknown;
      executor_key: string;
      executor_version: number;
      input_ref: unknown;
      variable_set_revision: number | null;
      may_contact_provider: boolean;
      may_cause_external_side_effect: boolean;
      node_id: string;
      operation_key: string | null;
      provider_key: string | null;
      side_effect_class: string;
      traceparent: string | null;
      workflow_id: string;
    }> & { execution_deadline_at: Date; retention_expires_at: Date }
  >(
    `select definition_key,definition_version,dry_run,executable_node_json,
            executor_key,executor_version,input_ref,preview.variable_set_revision,may_contact_provider,
             may_cause_external_side_effect,node_id,operation_key,provider_key,
             side_effect_class,
            traceparent,workflow_id,
            execution_deadline_at,
            expires_at as retention_expires_at
     from app.preview_runs preview
     where preview.workspace_id=$1 and preview.id=$2`,
    [input.workspaceId, input.previewRunId],
  );
  const attempts = await client.query<{
    dispatch_marked_at: Date | null;
    provider_dispatch_binding: string | null;
    provider_idempotency_key: string | null;
    side_effect_class: string;
  }>(
    `select dispatch_marked_at,provider_idempotency_key,
            provider_dispatch_binding,side_effect_class
     from app.preview_attempts
     where workspace_id=$1 and id=$2`,
    [input.workspaceId, input.previewAttemptId],
  );
  const run = runs.rows[0];
  const attempt = attempts.rows[0];
  if (run === undefined || attempt === undefined)
    throw new PreviewAttemptStateError('pins_missing');
  const sideEffectClass = z
    .enum(['safe', 'idempotent_with_key', 'unsafe'])
    .parse(attempt.side_effect_class);
  return Object.freeze({
    // PostgreSQL bigint arrives as a string through node-postgres; coerce
    // at this boundary before the numeric contract applies.
    attemptFenceToken: z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(input.attemptFenceToken),
    workspaceId: input.workspaceId,
    definitionKey: run.definition_key,
    definitionVersion: run.definition_version,
    dryRun: z.enum(['not_supported', 'provider_supported']).parse(run.dry_run),
    executableNode: Object.freeze(
      executableNodeSchema.parse(run.executable_node_json),
    ),
    executorKey: run.executor_key,
    executorVersion: run.executor_version,
    executionDeadlineAt: run.execution_deadline_at,
    retentionExpiresAt: run.retention_expires_at,
    input: parseStoredExecutionValue(run.input_ref),
    variables: await readVariableSetValues(
      drizzle(client),
      input.workspaceId,
      run.variable_set_revision,
    ),
    mayContactProvider: run.may_contact_provider,
    mayCauseExternalSideEffect: run.may_cause_external_side_effect,
    nodeId: run.node_id,
    ...(run.operation_key === null ? {} : { operationKey: run.operation_key }),
    previewAttemptId: input.previewAttemptId,
    previewRunId: input.previewRunId,
    ...(run.provider_key === null ? {} : { providerKey: run.provider_key }),
    ...(attempt.provider_idempotency_key === null
      ? {}
      : { providerIdempotencyKey: attempt.provider_idempotency_key }),
    ...(attempt.provider_dispatch_binding === null
      ? {}
      : { providerDispatchBinding: attempt.provider_dispatch_binding }),
    ...(attempt.dispatch_marked_at === null
      ? {}
      : { providerDispatchUnresolved: true as const }),
    sideEffectClass,
    ...(run.traceparent === null ? {} : { traceparent: run.traceparent }),
    workflowId: run.workflow_id,
  });
}

export async function lockPreviewClaimState(
  client: PoolClient,
  parsed: Pick<
    PreviewAttemptLease,
    'workspaceId' | 'previewAttemptId' | 'previewRunId'
  >,
) {
  const locked = await client.query<{
    attempt_status: string;
    dispatch_marked_at: Date | null;
    live_lease: boolean | null;
    run_deadline_expired: boolean;
    run_status: string;
    side_effect_class: string;
  }>(
    `select attempt.status as attempt_status,
                attempt.dispatch_marked_at,
                attempt.side_effect_class,
                (attempt.lease_expires_at is not null
                   and attempt.lease_expires_at > clock_timestamp())
                  as live_lease,
                (run.execution_deadline_at <= clock_timestamp())
                  as run_deadline_expired,
                run.status as run_status
         from app.preview_attempts attempt
         join app.preview_runs run
           on run.workspace_id = attempt.workspace_id
          and run.id = attempt.preview_run_id
         where attempt.workspace_id=$1
           and attempt.id=$2
           and attempt.preview_run_id=$3
         for update of attempt, run`,
    [parsed.workspaceId, parsed.previewAttemptId, parsed.previewRunId],
  );
  const state = locked.rows[0];
  if (state === undefined)
    throw new PreviewAttemptStateError('attempt_not_found');
  if (!previewPairConsistent(state.attempt_status, state.run_status))
    throw new PreviewAttemptStateError('run_attempt_divergence');

  return state;
}
