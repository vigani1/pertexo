import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowTestSuites,
  workflows,
  workspaces,
} from '@pertexo/database/schema';

import type { WorkflowActor } from '../../shared/workflow-actor.types.js';
import { SECOND_INTERVAL } from '../../shared/sql-intervals.repository.js';
import type {
  SuiteRow,
  WorkflowTestSuiteInput,
} from './workflow-test-suite.types.js';

type SuiteKey = Readonly<{ workspaceId: string; id: string }>;

function sameSuite(suite: SuiteKey) {
  return and(
    eq(workflowTestSuites.workspaceId, suite.workspaceId),
    eq(workflowTestSuites.id, suite.id),
  );
}

/** Running suites due for a check, after the last one a scan reached. */
export async function findDueSuites(
  db: NodePgDatabase,
  after: Readonly<{ at: Date; id: string }> | undefined,
  limit: number,
) {
  return db
    .select({
      id: workflowTestSuites.id,
      workspaceId: workflowTestSuites.workspaceId,
      workflowId: workflowTestSuites.workflowId,
      startedBy: workflowTestSuites.startedBy,
      nextCheckAt: workflowTestSuites.nextCheckAt,
    })
    .from(workflowTestSuites)
    .where(
      and(
        eq(workflowTestSuites.status, 'running'),
        sql`${workflowTestSuites.expiresAt}>clock_timestamp()`,
        sql`${workflowTestSuites.nextCheckAt}<=clock_timestamp()`,
        after === undefined
          ? undefined
          : sql`(${workflowTestSuites.nextCheckAt},${workflowTestSuites.id})>(${after.at},${after.id}::uuid)`,
      ),
    )
    .orderBy(asc(workflowTestSuites.nextCheckAt), asc(workflowTestSuites.id))
    .limit(limit)
    .catch(rethrowQueryFailure);
}

/** Share-locks the suite's workspace; false when it is gone. */
export async function lockSuiteWorkspace(
  client: PoolClient,
  workspaceId: string,
): Promise<boolean> {
  const workspace = await drizzle(client)
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('share')
    .catch(rethrowQueryFailure);
  return workspace.length === 1;
}

/** Share-locks the suite's workflow and reads whether it is still active. */
export async function lockSuiteWorkflowStatus(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
) {
  const workflow = await drizzle(client)
    .select({ lifecycleStatus: workflows.lifecycleStatus })
    .from(workflows)
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  return workflow[0]?.lifecycleStatus;
}

/** Locks the running, live suite if it is due and no other worker holds it. */
export async function lockDueSuite(
  client: PoolClient,
  suite: SuiteKey,
): Promise<SuiteRow | undefined> {
  const found = await drizzle(client)
    .select()
    .from(workflowTestSuites)
    .where(
      and(
        sameSuite(suite),
        eq(workflowTestSuites.status, 'running'),
        sql`${workflowTestSuites.expiresAt}>clock_timestamp()`,
        sql`${workflowTestSuites.nextCheckAt}<=clock_timestamp()`,
      ),
    )
    .for('update', { skipLocked: true })
    .catch(rethrowQueryFailure);
  return found[0];
}

/** Locks the workflow's live suite for a member's command. */
export async function lockLiveSuite(
  client: PoolClient,
  input: WorkflowTestSuiteInput,
): Promise<SuiteRow | undefined> {
  const found = await drizzle(client)
    .select()
    .from(workflowTestSuites)
    .where(
      and(
        eq(workflowTestSuites.workspaceId, input.workspaceId),
        eq(workflowTestSuites.workflowId, input.workflowId),
        eq(workflowTestSuites.id, input.suiteId),
        sql`${workflowTestSuites.expiresAt}>clock_timestamp()`,
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return found[0];
}

/** Whether the actor already runs a suite of this workflow. */
export async function hasRunningSuite(
  client: PoolClient,
  input: WorkflowActor,
): Promise<boolean> {
  const active = await drizzle(client)
    .select({ id: workflowTestSuites.id })
    .from(workflowTestSuites)
    .where(
      and(
        eq(workflowTestSuites.workspaceId, input.workspaceId),
        eq(workflowTestSuites.workflowId, input.workflowId),
        eq(workflowTestSuites.startedBy, input.actorId),
        eq(workflowTestSuites.status, 'running'),
      ),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  return active.length !== 0;
}

/** Stores a new suite, its first checkpoint as JSON text, and returns its row. */
export async function insertSuite(
  client: PoolClient,
  {
    initialCheckpointJson,
    ...values
  }: Omit<typeof workflowTestSuites.$inferInsert, 'initialCheckpoint'> &
    Readonly<{ initialCheckpointJson: string }>,
): Promise<SuiteRow | undefined> {
  const inserted = await drizzle(client)
    .insert(workflowTestSuites)
    .values({
      ...values,
      initialCheckpoint: sql`${initialCheckpointJson}::jsonb`,
    })
    .returning()
    .catch(rethrowQueryFailure);
  return inserted[0];
}

/** Asks the suite to stop for its member, and to be checked at once. */
export async function requestSuiteCancel(
  client: PoolClient,
  suite: SuiteKey,
): Promise<void> {
  await drizzle(client)
    .update(workflowTestSuites)
    .set({
      cancelRequested: true,
      stopReason: 'user_canceled',
      nextCheckAt: sql`clock_timestamp()`,
    })
    .where(sameSuite(suite))
    .catch(rethrowQueryFailure);
}

/** Keeps the first reason a suite stopped. */
export async function recordSuiteStopReason(
  client: PoolClient,
  suite: SuiteKey,
  reason: string,
): Promise<void> {
  await drizzle(client)
    .update(workflowTestSuites)
    .set({
      stopReason: sql`coalesce(${workflowTestSuites.stopReason},${reason})`,
    })
    .where(sameSuite(suite))
    .catch(rethrowQueryFailure);
}

/** The suite is looked at again after this many seconds. */
export async function scheduleSuiteCheck(
  client: PoolClient,
  suite: SuiteKey,
  afterSeconds: number,
): Promise<void> {
  await drizzle(client)
    .update(workflowTestSuites)
    .set({
      nextCheckAt: sql`clock_timestamp()+${afterSeconds}*${SECOND_INTERVAL}`,
    })
    .where(sameSuite(suite))
    .catch(rethrowQueryFailure);
}

/** Ends the suite with its final status. */
export async function completeSuite(
  client: PoolClient,
  suite: SuiteKey,
  status: SuiteRow['status'],
): Promise<void> {
  await drizzle(client)
    .update(workflowTestSuites)
    .set({ status, completedAt: sql`clock_timestamp()` })
    .where(sameSuite(suite))
    .catch(rethrowQueryFailure);
}

/** Admitting one case may fail without undoing the suite's other writes. */
export async function openCaseAdmission(client: PoolClient): Promise<void> {
  await drizzle(client)
    .execute(sql`savepoint suite_case_admission`)
    .catch(rethrowQueryFailure);
}

export async function keepCaseAdmission(client: PoolClient): Promise<void> {
  await drizzle(client)
    .execute(sql`release savepoint suite_case_admission`)
    .catch(rethrowQueryFailure);
}

export async function undoCaseAdmission(client: PoolClient): Promise<void> {
  await drizzle(client)
    .execute(sql`rollback to savepoint suite_case_admission`)
    .catch(rethrowQueryFailure);
}
