import type { PoolClient } from 'pg';
import type { CoordinatorCheckpoint } from './coordinator-checkpoint.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';
import { readWorkflowCallResultReference } from '../workflow-calls/workflow-call-result-reference.js';

/** Logical Call state changes never rewrite or fabricate its succeeded physical attempt. */
export async function persistCoordinatorCallTransitions(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    current: CoordinatorCheckpoint;
    plan: ParsedTransitionPlan;
  }>,
): Promise<void> {
  if (
    input.current.schemaVersion !== 3 ||
    input.plan.checkpoint.schemaVersion !== 3
  )
    return;
  const previous = new Map(
    input.current.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const next = new Map(
    input.plan.checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  for (const call of input.plan.checkpoint.calls) {
    const invocation = next.get(call.invocationKey);
    if (invocation === undefined) throw new CoordinatorRunStateCorruptError();
    if (previous.get(call.invocationKey)?.status === invocation.status)
      continue;
    const reference =
      invocation.output?.kind === 'workflow_call'
        ? await readWorkflowCallResultReference(client, {
            workspaceId: input.workspaceId,
            parentRunId: input.runId,
            invocationKey: call.invocationKey,
            childRunId: invocation.output.childRunId,
          })
        : null;
    const event = input.plan.events.find(
      ({ invocationKey, name }) =>
        invocationKey === call.invocationKey &&
        name === `node.${invocation.status}`,
    );
    const changed = await client.query(
      `update app.node_runs node
       set status=$4::varchar,output_ref=$5::jsonb,
           control_kind=case when $4::varchar='waiting' then 'workflow_call' else null end,
           completed_at=case when $4::varchar='waiting' then null else clock_timestamp() end,
           safe_error_code=$6,resume_at=null,retry_due_at=null,wait_kind=null,due_wakeup_at=null,
           updated_at=clock_timestamp()
       from app.node_attempts attempt
       where node.workspace_id=$1 and node.workflow_run_id=$2 and node.invocation_key=$3
         and node.current_attempt_id=$7 and node.current_attempt_number=1
         and attempt.workspace_id=node.workspace_id and attempt.id=$7 and attempt.node_run_id=node.id
         and attempt.status='succeeded' and attempt.attempt_number=1 and attempt.side_effect_class='unsafe'
         and node.input_ref=attempt.output_ref and node.status in ('succeeded','waiting')`,
      [
        input.workspaceId,
        input.runId,
        call.invocationKey,
        invocation.status,
        reference,
        event?.reasonCode ?? null,
        call.declarationAttemptId,
      ],
    );
    if (changed.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
}
