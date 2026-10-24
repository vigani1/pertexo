import { utf8ByteLength } from '@pertexo/workflow-model';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { WorkflowCallIntent } from '@pertexo/workflow-engine';
import { generatePersistedId } from '../../platform/persisted-id.js';
import {
  prepareStoredExecutionValue,
  STORED_EXECUTION_VALUE_LIMITS,
} from '../../platform/stored-execution-value.js';
import { CoordinatorRunStateCorruptError } from '../advance/contract.js';
import {
  terminalRunStatuses,
  type RunTransitionPlan,
} from '../advance/plan.js';

async function preparedInput(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  intent: WorkflowCallIntent,
): Promise<
  Readonly<{ json: string | null; checksum: string; refusal?: string }>
> {
  const result = await client.query<{ id: string; output_ref: unknown }>(
    `select attempt.id,attempt.output_ref
     from app.node_runs node join app.node_attempts attempt
       on attempt.workspace_id=node.workspace_id and attempt.node_run_id=node.id
       and attempt.id=node.current_attempt_id and attempt.attempt_number=node.current_attempt_number
     where node.workspace_id=$1 and node.workflow_run_id=$2 and node.invocation_key=$3
       and node.status='succeeded' and attempt.status='succeeded'
       and node.output_ref::jsonb=attempt.output_ref::jsonb`,
    [workspaceId, runId, intent.invocationKey],
  );
  const row = result.rows[0];
  if (row === undefined) throw new CoordinatorRunStateCorruptError();
  const prepared = prepareStoredExecutionValue(row.output_ref);
  const inputMismatch =
    (intent.input.kind === 'inline' &&
      (intent.input.attemptId !== row.id ||
        prepared.value.kind !== 'inline')) ||
    (intent.input.kind === 'artifact' &&
      (prepared.value.kind !== 'artifact' ||
        intent.input.artifactId !== prepared.value.artifactId));
  if (inputMismatch) throw new CoordinatorRunStateCorruptError();
  const checksum = createHash('sha256').update(prepared.json).digest('hex');
  const refusal = callInputRefusal(prepared);
  return {
    json: refusal === undefined ? prepared.json : null,
    checksum,
    ...(refusal === undefined ? {} : { refusal }),
  };
}

/** Intent, wait and wakeup are saved in the parent's checkpoint transaction. */
export async function persistCallIntents(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    plan: RunTransitionPlan;
    traceparent?: string;
  }>,
): Promise<void> {
  const { workspaceId, runId, plan } = input;
  const closed = terminalRunStatuses.has(plan.checkpoint.runStatus);
  for (const intent of plan.callIntents ?? []) {
    const prepared = await preparedInput(client, workspaceId, runId, intent);
    const refusal = closed ? 'call_parent_closed' : prepared.refusal;
    const result = await client.query<{ id: string }>(
      `insert into app.workflow_calls
       (id,workspace_id,parent_run_id,invocation_key,target_workflow_id,target_version_id,
        target_checksum,input_ref,input_checksum,deadline_at,status,safe_error_code,completed_at)
       select $1,$2,$3,$4,$5,$6,$7::varchar,$8::json,$9,
         least(run.deadline_at,clock_timestamp() +
           (version.executable_json #>> '{graph,settings,maxRunDurationMs}')::integer * interval '1 millisecond'),
         $10,$11,case when $11::varchar is null then null else clock_timestamp() end
       from app.workflow_runs run join app.workflow_versions version
         on version.workspace_id=run.workspace_id and version.workflow_id=$5 and version.id=$6
       where run.workspace_id=$2 and run.id=$3 and version.checksum=$7::varchar
       on conflict(workspace_id,parent_run_id,invocation_key) do nothing
       returning id`,
      [
        generatePersistedId(),
        workspaceId,
        runId,
        intent.invocationKey,
        intent.target.workflowId,
        intent.target.workflowVersionId,
        intent.target.executableChecksum,
        prepared.json,
        prepared.checksum,
        refusal === undefined ? 'pending' : 'refused',
        refusal ?? null,
      ],
    );
    if (result.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
    // A declaration may settle in the same transition as parent cancellation.
    // The ordinary event writer still requires a waiting logical node first.
    const wait = await client.query(
      `update app.node_runs set status='waiting',control_kind='workflow_call',output_ref=null,
         completed_at=null,resume_at=null,retry_due_at=null,due_wakeup_at=null,wait_kind=null,
         updated_at=clock_timestamp()
       where workspace_id=$1 and workflow_run_id=$2 and invocation_key=$3 and status='succeeded'`,
      [workspaceId, runId, intent.invocationKey],
    );
    if (wait.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
}

function callInputRefusal(
  prepared: ReturnType<typeof prepareStoredExecutionValue>,
): string | undefined {
  if (prepared.value.kind === 'artifact') {
    return 'call_input_artifact_unsupported';
  }
  if (
    utf8ByteLength(prepared.json) > STORED_EXECUTION_VALUE_LIMITS.inlineBytes
  ) {
    return 'call_input_too_large';
  }
  return undefined;
}
