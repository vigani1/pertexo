import {
  workflowRuns,
  workflowTestSnapshots,
  workflowTestSuites,
  workflowInputCasePayloads,
  workflowInputCases,
  workflowStepSamples,
  webhookTestEvents,
} from '@pertexo/database/schema';
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  lt,
  lte,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { retainedTestRunSql, testRunSql } from '../../runs/data-policy.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { deletionRule } from './rows.repository.js';

const query = new QueryBuilder(),
  run = alias(workflowRuns, 'run');
const liveSnapshotRun = query
  .select({ one: sql`1` })
  .from(run)
  .where(
    and(
      eq(run.workspaceId, workflowTestSnapshots.workspaceId),
      eq(run.workflowVersionId, workflowTestSnapshots.id),
      testRunSql('run'),
      or(
        inArray(run.status, ['queued', 'running', 'waiting']),
        retainedTestRunSql('run'),
      ),
    ),
  );
const snapshotExpired = lte(
  workflowTestSnapshots.expiresAt,
  sql`clock_timestamp()`,
);
const noRetainedRun = notExists(liveSnapshotRun);
export const testSnapshots = deletionRule('workflow_test_snapshots', {
  table: workflowTestSnapshots,
  keys: [workflowTestSnapshots.id],
  condition: and(
    snapshotExpired,
    noRetainedRun,
    notExists(
      query
        .select({ one: sql`1` })
        .from(workflowTestSuites)
        .where(
          and(
            eq(
              workflowTestSuites.workspaceId,
              workflowTestSnapshots.workspaceId,
            ),
            eq(workflowTestSuites.snapshotId, workflowTestSnapshots.id),
          ),
        ),
    ),
  ),
  orderBy: [workflowTestSnapshots.expiresAt, workflowTestSnapshots.id],
  recheck: and(snapshotExpired, noRetainedRun),
});
// Payloads of deleted cases and of earlier case revisions.
export const inputPayloads = deletionRule('input_case_payloads', {
  table: workflowInputCasePayloads,
  keys: [
    workflowInputCasePayloads.workspaceId,
    workflowInputCasePayloads.caseId,
    workflowInputCasePayloads.revision,
  ],
  condition: exists(
    query
      .select({ one: sql`1` })
      .from(workflowInputCases)
      .where(
        and(
          eq(
            workflowInputCases.workspaceId,
            workflowInputCasePayloads.workspaceId,
          ),
          eq(workflowInputCases.id, workflowInputCasePayloads.caseId),
          or(
            isNotNull(workflowInputCases.deletedAt),
            lt(workflowInputCasePayloads.revision, workflowInputCases.revision),
          ),
        ),
      ),
  ),
  orderBy: [
    workflowInputCasePayloads.workspaceId,
    workflowInputCasePayloads.caseId,
    workflowInputCasePayloads.revision,
  ],
});
// A deleted case goes once its payloads are gone.
export const deletedInputCases = deletionRule('deleted_input_cases', {
  table: workflowInputCases,
  keys: [workflowInputCases.workspaceId, workflowInputCases.id],
  condition: and(
    isNotNull(workflowInputCases.deletedAt),
    notExists(
      query
        .select({ one: sql`1` })
        .from(workflowInputCasePayloads)
        .where(
          and(
            eq(
              workflowInputCasePayloads.workspaceId,
              workflowInputCases.workspaceId,
            ),
            eq(workflowInputCasePayloads.caseId, workflowInputCases.id),
          ),
        ),
    ),
  ),
  orderBy: [workflowInputCases.workspaceId, workflowInputCases.id],
});
export const stepSamples = deletionRule('workflow_step_samples', {
  table: workflowStepSamples,
  keys: [workflowStepSamples.workspaceId, workflowStepSamples.id],
  condition: lte(workflowStepSamples.expiresAt, sql`clock_timestamp()`),
  orderBy: [workflowStepSamples.expiresAt, workflowStepSamples.id],
});
export const webhookTests = {
  name: 'webhook_test_events',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client);
    const page = db.$with('page').as(
      db
        .select({
          workspaceId: webhookTestEvents.workspaceId,
          id: webhookTestEvents.id,
        })
        .from(webhookTestEvents)
        .where(lte(webhookTestEvents.expiresAt, sql`clock_timestamp()`))
        .orderBy(asc(webhookTestEvents.expiresAt), asc(webhookTestEvents.id))
        .limit(pageSize)
        .for('update', { skipLocked: true }),
    );
    return (
      await db
        .with(page)
        .delete(webhookTestEvents)
        .where(
          exists(
            db
              .select({ one: sql`1` })
              .from(page)
              .where(
                and(
                  eq(page.workspaceId, webhookTestEvents.workspaceId),
                  eq(page.id, webhookTestEvents.id),
                ),
              ),
          ),
        )
        .returning({ one: sql`1` })
        .catch(rethrowQueryFailure)
    ).length;
  },
} as const;
