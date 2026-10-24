import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import {
  previewRuns,
  nodeRuns,
  workflowRuns,
} from '../../schema/runs/execution.js';
import { webhookTestEvents } from '../../schema/triggers/test-events.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
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
    const now = await drizzle(client)
      .execute<{ expired: boolean }>(
        sql`select ${current.expiresAt}::timestamptz<=clock_timestamp() expired`,
      )
      .catch(rethrowQueryFailure);
    if (now.rows[0]?.expired !== false)
      throw new WorkflowStepSampleError('expired');
    return {
      output: current.outputRef,
      kind: current.sourceKind,
      runId: current.sourceRunId,
      nodeRunId: current.sourceNodeRunId,
      previewId: current.sourcePreviewId,
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
    const [row] = await drizzle(client)
      .select({ outputRef: webhookTestEvents.outputRef })
      .from(webhookTestEvents)
      .where(
        and(
          eq(webhookTestEvents.workspaceId, input.workspaceId),
          eq(webhookTestEvents.workflowId, input.workflowId),
          eq(webhookTestEvents.nodeId, input.nodeId),
          eq(webhookTestEvents.createdBy, input.actorId),
          eq(webhookTestEvents.id, source.listenerId),
          eq(webhookTestEvents.binding, binding),
          gt(webhookTestEvents.expiresAt, sql`clock_timestamp()`),
          isNotNull(webhookTestEvents.outputRef),
        ),
      )
      .for('share')
      .catch(rethrowQueryFailure);
    if (row === undefined)
      throw new WorkflowStepSampleError('source_unavailable');
    return {
      output: inlineSampleOutput(row.outputRef),
      kind: source.kind,
      runId: null,
      nodeRunId: null,
      previewId: null,
    };
  }
  const db = drizzle(client);
  const node = alias(nodeRuns, 'node'),
    run = alias(workflowRuns, 'run');
  const rows =
    source.kind === 'preview'
      ? await db
          .select({ outputRef: previewRuns.outputRef })
          .from(previewRuns)
          .where(
            and(
              eq(previewRuns.workspaceId, input.workspaceId),
              eq(previewRuns.workflowId, input.workflowId),
              eq(previewRuns.nodeId, input.nodeId),
              eq(previewRuns.id, source.previewRunId),
              eq(previewRuns.status, 'succeeded'),
              gt(previewRuns.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .catch(rethrowQueryFailure)
      : await db
          .select({ outputRef: node.outputRef })
          .from(node)
          .innerJoin(
            run,
            and(
              eq(run.workspaceId, node.workspaceId),
              eq(run.id, node.workflowRunId),
            ),
          )
          .where(
            and(
              eq(node.workspaceId, input.workspaceId),
              eq(run.workflowId, input.workflowId),
              eq(node.nodeId, input.nodeId),
              eq(node.id, source.nodeRunId),
              eq(run.id, source.runId),
              eq(node.status, 'succeeded'),
              isNotNull(node.outputRef),
              isNull(run.detailsPurgedAt),
              sql.raw(retainedTestRunSql('run', 'clock_timestamp()')),
              sql`(${run.completedAt} is null or ${run.completedAt}>clock_timestamp()-${sql.raw(runRetentionIntervalSql('run'))})`,
            ),
          )
          .catch(rethrowQueryFailure);
  const row = rows[0];
  if (row === undefined || row.outputRef === null)
    throw new WorkflowStepSampleError('source_unavailable');
  return {
    output: inlineSampleOutput(row.outputRef),
    kind: source.kind,
    runId: source.kind === 'run' ? source.runId : null,
    nodeRunId: source.kind === 'run' ? source.nodeRunId : null,
    previewId: source.kind === 'preview' ? source.previewRunId : null,
  };
}
