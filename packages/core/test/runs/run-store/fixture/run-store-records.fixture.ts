import { createHash, randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { parseWorkspaceId } from '@pertexo/database/primitives';
import { databaseSchema } from '@pertexo/database/testing';
import { lockRunAcceptanceCommand } from '../../../../src/testing.js';

import {
  workerBaseUrl,
  apiBaseUrl,
  workspaceA,
  workflowA,
  versionA,
} from './context.js';
import { asRuntime } from './queries.js';

export function checkpoint(input: {
  workflowVersionId?: string;
  revision?: number;
  runStatus?:
    | 'queued'
    | 'running'
    | 'waiting'
    | 'succeeded'
    | 'failed'
    | 'canceled'
    | 'timed_out'
    | 'outcome_unknown';
  nextEventSequence?: number;
  cancelRequested?: boolean;
  deadlineExpired?: boolean;
  invocations?: readonly Record<string, unknown>[];
  readySet?: readonly string[];
  admittedInvocationKeys?: readonly string[];
}) {
  return {
    workflowVersionId: input.workflowVersionId ?? versionA,
    revision: input.revision ?? 0,
    runStatus: input.runStatus ?? 'queued',
    nextEventSequence: input.nextEventSequence ?? 2,
    readySet: input.readySet ?? [],
    admittedInvocationKeys: input.admittedInvocationKeys ?? [],
    invocations: input.invocations ?? [],
    joins: [],
    loops: [],
    remainingIterationBudget: 0,
    cancelRequested: input.cancelRequested ?? false,
    deadlineExpired: input.deadlineExpired ?? false,
    branchSelections: [],
  } as const;
}

export async function insertRun(input: {
  workspaceId?: string;
  workflowId?: string;
  workflowVersionId?: string;
  schedulerState?: unknown;
  status?: string;
  triggerType?: string;
  deadlineAt?: string;
  inputRef?: unknown;
  failureNotificationPolicy?: Readonly<{
    destinationId: string;
    destinationConfigVersion: number;
    sideEffectClass: string;
    connectionSecretVersionId: string;
  }>;
}): Promise<string> {
  const workspaceId = input.workspaceId ?? workspaceA;
  const runId = randomUUID();
  const workflowVersionId = input.workflowVersionId ?? versionA;
  await asRuntime(apiBaseUrl, workspaceId, async (client) => {
    if ((input.triggerType ?? 'manual') === 'manual') {
      await lockRunAcceptanceCommand(
        {
          db: drizzle(client, { schema: databaseSchema }),
          workspaceId: parseWorkspaceId(workspaceId),
        },
        {
          scope: `workflow:${input.workflowId ?? workflowA}:manual`,
          idempotencyKeyHash: createHash('sha256').update(runId).digest('hex'),
        },
      );
    }
    await client.query(
      `insert into app.workflow_runs (
         id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
           deadline_at,input_ref,input_ref_expires_at,
          failure_notification_destination_id,
           failure_notification_destination_config_version,
           failure_notification_side_effect_class,
           failure_notification_connection_secret_version_id
          ) values ($1,$2,$3,$4,$12,$5,$6,$7::jsonb,
            case when $7::jsonb is null then null else now()+interval '30 days' end,$8,$9,$10,$11)`,
      [
        runId,
        workspaceId,
        input.workflowId ?? workflowA,
        workflowVersionId,
        input.status ?? 'queued',
        input.deadlineAt ?? null,
        input.inputRef === undefined ? null : JSON.stringify(input.inputRef),
        input.failureNotificationPolicy?.destinationId ?? null,
        input.failureNotificationPolicy?.destinationConfigVersion ?? null,
        input.failureNotificationPolicy?.sideEffectClass ?? null,
        input.failureNotificationPolicy?.connectionSecretVersionId ?? null,
        input.triggerType ?? 'manual',
      ],
    );
    await client.query(
      `insert into app.run_events
         (workspace_id,workflow_run_id,sequence,type,payload)
       values ($1,$2,1,'run.queued','{}'::jsonb)`,
      [workspaceId, runId],
    );
    const state = input.schedulerState ?? checkpoint({ workflowVersionId });
    const stateRevision = schedulerRevision(input.schedulerState);
    await client.query(
      `insert into app.run_checkpoints (
         workflow_run_id,workspace_id,workflow_version_id,revision,scheduler_state
       ) values ($1,$2,$3,$4,$5::jsonb)`,
      [
        runId,
        workspaceId,
        workflowVersionId,
        stateRevision,
        JSON.stringify(state),
      ],
    );
  });
  return runId;
}

export async function seedSucceededFact(
  runId: string,
  invocationKey: string,
  storedValue: unknown,
): Promise<Readonly<{ attemptId: string; nodeRunId: string }>> {
  const nodeRunId = randomUUID();
  const attemptId = randomUUID();
  await asRuntime(workerBaseUrl, workspaceA, async (client) => {
    await client.query(
      `insert into app.node_runs (
         id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
         status,side_effect_class,current_attempt_id,current_attempt_number,output_ref
       ) values ($1,$2,$3,$4,$5,'{}','succeeded','safe',$6,1,$7::jsonb)`,
      [
        nodeRunId,
        workspaceA,
        runId,
        invocationKey.split('/').at(-1) ?? invocationKey,
        invocationKey,
        attemptId,
        JSON.stringify(storedValue),
      ],
    );
    await client.query(
      `insert into app.node_attempts (
         id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
       ) values ($1,$2,$3,1,'succeeded','safe',$4::jsonb)`,
      [attemptId, workspaceA, nodeRunId, JSON.stringify(storedValue)],
    );
    await client.query(
      `insert into app.run_events
         (workspace_id,workflow_run_id,sequence,type,payload)
       values ($1,$2,2,'node.succeeded',$3::jsonb)`,
      [workspaceA, runId, JSON.stringify({ nodeRunId, attemptId })],
    );
  });
  return { nodeRunId, attemptId };
}

function schedulerRevision(schedulerState: unknown): number {
  return typeof schedulerState === 'object' &&
    schedulerState !== null &&
    'revision' in schedulerState &&
    typeof schedulerState.revision === 'number'
    ? schedulerState.revision
    : 0;
}
