import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import { alias } from 'drizzle-orm/pg-core';

import {
  previewRuns,
  nodeRuns,
  workflowRuns,
  webhookTestEvents,
} from '@pertexo/database/schema';

import { rethrowQueryFailure } from '@pertexo/database/primitives';

import {
  retainedTestRunSql,
  runRetentionIntervalSql,
} from '../../shared/run-records/run-retention.repository.js';

import type { PoolClient } from 'pg';

import type { SampleCommand, SampleSource } from './step-sample.types.js';

/** Whether the stored expiry has passed by database time; an unreadable answer counts as expired. */
export async function sampleExpired(
  client: PoolClient,
  expiresAt: Date,
): Promise<boolean> {
  const now = await drizzle(client)
    .execute<{ expired: boolean }>(
      sql`select ${expiresAt}::timestamptz<=clock_timestamp() expired`,
    )
    .catch(rethrowQueryFailure);
  return now.rows[0]?.expired !== false;
}

/** The creator's live test event for this step and binding, share-locked. */
export async function shareLockTestEvent(
  client: PoolClient,
  input: SampleCommand,
  { listenerId, binding }: Readonly<{ listenerId: string; binding: string }>,
) {
  const [row] = await drizzle(client)
    .select({ outputRef: webhookTestEvents.outputRef })
    .from(webhookTestEvents)
    .where(
      and(
        eq(webhookTestEvents.workspaceId, input.workspaceId),
        eq(webhookTestEvents.workflowId, input.workflowId),
        eq(webhookTestEvents.nodeId, input.nodeId),
        eq(webhookTestEvents.createdBy, input.actorId),
        eq(webhookTestEvents.id, listenerId),
        eq(webhookTestEvents.binding, binding),
        gt(webhookTestEvents.expiresAt, sql`clock_timestamp()`),
        isNotNull(webhookTestEvents.outputRef),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  return row;
}

/** The output of the succeeded preview or retained run step the source names. */
export async function readSourceOutput(
  client: PoolClient,
  input: SampleCommand,
  source: Exclude<SampleSource, { kind: 'confirm' | 'json' | 'webhook_test' }>,
) {
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
              retainedTestRunSql('run', 'clock_timestamp()'),
              sql`(${run.completedAt} is null or ${run.completedAt}>clock_timestamp()-${runRetentionIntervalSql('run')})`,
            ),
          )
          .catch(rethrowQueryFailure);
  return rows[0];
}
