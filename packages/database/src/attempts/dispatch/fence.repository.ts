import type { PoolClient } from 'pg';

export type ExecutionCapabilityScope = Readonly<{
  workspaceId: string;
  runId: string;
  nodeRunId: string;
  attemptId: string;
  attemptNumber: number;
  workerId: string;
  fenceToken: number;
  previewRunId?: string;
  nodeId: string;
  invocationKey: string;
}>;
export class ExecutionCapabilityExpiredError extends Error {
  override readonly name = 'ExecutionCapabilityExpiredError';
  constructor(message = 'This execution attempt is no longer current.') {
    super(message);
  }
}
export async function lockCapabilityExecution(
  client: PoolClient,
  input: ExecutionCapabilityScope,
): Promise<void> {
  const workspace = await client.query<{ status: string }>(
    'select status from app.workspaces where id=$1 for share',
    [input.workspaceId],
  );
  if (workspace.rows[0]?.status !== 'active')
    throw new ExecutionCapabilityExpiredError('The workspace is not active.');
  if (input.previewRunId !== undefined) {
    if (input.previewRunId !== input.runId)
      throw new ExecutionCapabilityExpiredError();
    await client.query(
      'select id from app.preview_runs where workspace_id=$1 and id=$2 for update',
      [input.workspaceId, input.previewRunId],
    );
    await client.query(
      'select id from app.preview_attempts where workspace_id=$1 and id=$2 for update',
      [input.workspaceId, input.attemptId],
    );
  } else {
    await client.query(
      'select id from app.workflow_runs where workspace_id=$1 and id=$2 for update',
      [input.workspaceId, input.runId],
    );
    await client.query(
      'select id from app.node_runs where workspace_id=$1 and id=$2 for update',
      [input.workspaceId, input.nodeRunId],
    );
    await client.query(
      'select id from app.node_attempts where workspace_id=$1 and id=$2 for update',
      [input.workspaceId, input.attemptId],
    );
  }
}
export async function assertCapabilityExecution(
  client: PoolClient,
  input: ExecutionCapabilityScope,
  {
    requireDispatch = false,
  }: Readonly<{ requireDispatch?: boolean | undefined }> = {},
): Promise<void> {
  const parameters: unknown[] = [
    input.workspaceId,
    input.attemptId,
    input.runId,
    input.workerId,
    input.fenceToken,
  ];
  let valid: boolean | undefined;
  if (input.previewRunId !== undefined) {
    const found = await client.query<{ valid: boolean }>(
      `select (attempt.status='running' and attempt.lease_owner=$4 and attempt.fence_token=$5 and attempt.lease_expires_at>clock_timestamp() and run.status='running' and run.execution_deadline_at>clock_timestamp() and (not $6::boolean or attempt.dispatch_marked_at is not null)) valid from app.preview_attempts attempt join app.preview_runs run on run.workspace_id=attempt.workspace_id and run.id=attempt.preview_run_id where attempt.workspace_id=$1 and attempt.id=$2 and run.id=$3`,
      [...parameters, requireDispatch],
    );
    valid = found.rows[0]?.valid;
  } else {
    parameters.push(
      input.nodeRunId,
      input.nodeId,
      input.invocationKey,
      input.attemptNumber,
      requireDispatch,
    );
    const found = await client.query<{ valid: boolean }>(
      `select (attempt.status='running' and attempt.lease_owner=$4 and attempt.fence_token=$5 and attempt.lease_expires_at>clock_timestamp() and node.current_attempt_id=attempt.id and run.status in ('running','waiting') and run.cancel_requested_at is null and (run.deadline_at is null or run.deadline_at>clock_timestamp()) and (not $10::boolean or attempt.dispatch_marked_at is not null)) valid from app.node_attempts attempt join app.node_runs node on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id join app.workflow_runs run on run.workspace_id=node.workspace_id and run.id=node.workflow_run_id where attempt.workspace_id=$1 and attempt.id=$2 and run.id=$3 and node.id=$6 and node.node_id=$7 and node.invocation_key=$8 and attempt.attempt_number=$9`,
      parameters,
    );
    valid = found.rows[0]?.valid;
  }
  if (!(valid ?? false)) throw new ExecutionCapabilityExpiredError();
}
