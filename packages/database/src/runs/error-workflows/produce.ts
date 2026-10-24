import type { PoolClient } from 'pg';
import type { RunTransitionPlan } from '../advance/plan.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';
import { errorWorkflowInput, errorWorkflowFailure } from './summary.js';
import { readErrorWorkflowStep } from './step.js';

/** The terminal transition and its unique intent/outbox either all commit or none do. */
export async function persistErrorWorkflowIntent(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    workflowId: string;
    workflowVersionId: string;
    cancellationRequested: boolean;
    plan: RunTransitionPlan;
    traceparent?: string;
  }>,
): Promise<void> {
  if (
    input.cancellationRequested ||
    !input.plan.events.some((event) =>
      ['run.failed', 'run.timed_out', 'run.outcome_unknown'].includes(
        event.name,
      ),
    )
  )
    return;
  const policy = await client.query<{
    target_workflow_id: string;
    target_version_id: string | null;
    workflow_name: string;
  }>(
    `select policy.target_workflow_id,target.published_version_id target_version_id,source.name workflow_name
    from app.workflow_error_policies policy join app.workflows source on source.workspace_id=policy.workspace_id and source.id=policy.workflow_id
    join app.workflows target on target.workspace_id=policy.workspace_id and target.id=policy.target_workflow_id
    join app.workflow_runs run on run.workspace_id=policy.workspace_id and run.id=$3
    where policy.workspace_id=$1 and policy.workflow_id=$2 and not run.error_workflow_origin`,
    [input.workspaceId, input.workflowId, input.runId],
  );
  const row = policy.rows[0];
  if (row === undefined) return;
  const failed = errorWorkflowFailure(input.plan);
  const context = errorWorkflowInput({
    ...input,
    workflowName: row.workflow_name,
    ...(failed === undefined
      ? {}
      : {
          step: await readErrorWorkflowStep(client, {
            ...input,
            invocationKey: failed.invocationKey,
            nodeId: failed.nodeId,
          }),
        }),
  });
  if (row.target_version_id === null) {
    await client.query(
      `insert into app.run_error_workflow_intents(workspace_id,source_run_id,target_workflow_id,target_version_id,context,outbox_event_id,status,refusal_code,completed_at)
      values($1,$2,$3,null,$4::jsonb,null,'refused','target_not_published',clock_timestamp())
      on conflict(workspace_id,source_run_id) do nothing`,
      [
        input.workspaceId,
        input.runId,
        row.target_workflow_id,
        JSON.stringify(context),
      ],
    );
    return;
  }
  const outboxEventId = generatePersistedId();
  const inserted = await client.query(
    `insert into app.run_error_workflow_intents(workspace_id,source_run_id,target_workflow_id,target_version_id,context,outbox_event_id) values($1,$2,$3,$4,$5::jsonb,$6) on conflict(workspace_id,source_run_id) do nothing`,
    [
      input.workspaceId,
      input.runId,
      row.target_workflow_id,
      row.target_version_id,
      JSON.stringify(context),
      outboxEventId,
    ],
  );
  if (inserted.rowCount !== 1) return;
  const payload = {
    workspaceId: input.workspaceId,
    sourceRunId: input.runId,
    outboxEventId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  };
  await client.query(
    `insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum) values($1,$2,'start-error-workflow','workflow-run',$3,$4::jsonb,$5)`,
    [
      outboxEventId,
      input.workspaceId,
      input.runId,
      JSON.stringify(payload),
      canonicalOutboxPayloadChecksum(payload),
    ],
  );
}
