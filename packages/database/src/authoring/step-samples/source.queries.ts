import { bindResourcePredicate } from '../../tenant-access/resources/scope.queries.js';
import {
  retainedTestRunSql,
  runRetentionIntervalSql,
} from '../../runs/data-policy.js';
import type { PoolClient } from 'pg';
import { inlineSampleOutput } from './records.repository.js';
import {
  WorkflowStepSampleError,
  type SampleCommand,
  type SampleRow,
  type SampleSource,
} from './contract.js';

export async function captureSampleSource(
  client: PoolClient,
  input: SampleCommand,
  {
    source,
    current,
    binding,
  }: Readonly<{
    source: SampleSource;
    current: SampleRow | undefined;
    binding: string;
  }>,
) {
  if (source.kind === 'confirm') {
    if (current === undefined) throw new WorkflowStepSampleError('changed');
    const now = await client.query<{ expired: boolean }>(
      'select $1::timestamptz <= clock_timestamp() expired',
      [current.expires_at],
    );
    if (now.rows[0]?.expired !== false)
      throw new WorkflowStepSampleError('expired');
    return {
      output: current.output_ref,
      kind: current.source_kind,
      runId: current.source_run_id,
      nodeRunId: current.source_node_run_id,
      previewId: current.source_preview_id,
    };
  }
  if (source.kind === 'json')
    return {
      output: inlineSampleOutput({ kind: 'inline', value: source.value }),
      kind: source.kind,
      runId: null,
      nodeRunId: null,
      previewId: null,
    };
  if (source.kind === 'webhook_test') {
    const rows = await client.query<{ output_ref: unknown }>(
      `select output_ref from app.webhook_test_events where workspace_id=$1 and workflow_id=$2 and node_id=$3 and created_by=$4 and id=$5 and binding=$6 and expires_at>clock_timestamp() and output_ref is not null for share`,
      [
        input.workspaceId,
        input.workflowId,
        input.nodeId,
        input.actorId,
        source.listenerId,
        binding,
      ],
    );
    const row = rows.rows[0];
    if (row === undefined)
      throw new WorkflowStepSampleError('source_unavailable');
    return {
      output: inlineSampleOutput(row.output_ref),
      kind: source.kind,
      runId: null,
      nodeRunId: null,
      previewId: null,
    };
  }
  const rows =
    source.kind === 'preview'
      ? await client.query<{ output_ref: unknown }>(
          `select output_ref from app.preview_runs where workspace_id=$1 and workflow_id=$2 and node_id=$3 and id=$4 and status='succeeded' and expires_at > clock_timestamp()`,
          [
            input.workspaceId,
            input.workflowId,
            input.nodeId,
            source.previewRunId,
          ],
        )
      : await client.query<{ output_ref: unknown }>(
          `select node.output_ref from app.node_runs node join app.workflow_runs run on run.workspace_id=node.workspace_id and run.id=node.workflow_run_id where node.workspace_id=$1 and run.workflow_id=$2 and node.node_id=$3 and node.id=$4 and run.id=$5 and node.status='succeeded' and node.output_ref is not null and run.details_purged_at is null and ${bindResourcePredicate(retainedTestRunSql('run', 'clock_timestamp()').inlineParams(), [])} and (run.completed_at is null or run.completed_at > clock_timestamp()-${bindResourcePredicate(runRetentionIntervalSql('run').inlineParams(), [])})`,
          [
            input.workspaceId,
            input.workflowId,
            input.nodeId,
            source.nodeRunId,
            source.runId,
          ],
        );
  const row = rows.rows[0];
  if (row === undefined || row.output_ref === null)
    throw new WorkflowStepSampleError('source_unavailable');
  return {
    output: inlineSampleOutput(row.output_ref),
    kind: source.kind,
    runId: source.kind === 'run' ? source.runId : null,
    nodeRunId: source.kind === 'run' ? source.nodeRunId : null,
    previewId: source.kind === 'preview' ? source.previewRunId : null,
  };
}
