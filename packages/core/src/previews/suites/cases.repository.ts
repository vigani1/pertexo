import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workflowTestSuiteCases } from '@pertexo/database/schema';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { SuiteCaseRow } from './workflow-test-suite.types.js';

type SuiteKey = Readonly<{ workspaceId: string; suiteId: string }>;

function inSuite({ workspaceId, suiteId }: SuiteKey) {
  return and(
    eq(workflowTestSuiteCases.workspaceId, workspaceId),
    eq(workflowTestSuiteCases.suiteId, suiteId),
  );
}

/** A stopped or canceled suite won't reach these. */
export async function skipPendingCases(
  client: PoolClient,
  workspaceId: string,
  suiteId: string,
): Promise<void> {
  await drizzle(client)
    .update(workflowTestSuiteCases)
    .set({ status: 'skipped' })
    .where(
      and(
        inSuite({ workspaceId, suiteId }),
        eq(workflowTestSuiteCases.status, 'pending'),
      ),
    )
    .catch(rethrowQueryFailure);
}

/** Stores the suite's case manifest. */
export async function insertSuiteCases(
  client: PoolClient,
  cases: readonly (typeof workflowTestSuiteCases.$inferInsert)[],
): Promise<void> {
  await drizzle(client)
    .insert(workflowTestSuiteCases)
    .values([...cases])
    .catch(rethrowQueryFailure);
}

/** One case of the suite by its position. */
export async function readSuiteCase(
  client: PoolClient,
  suite: SuiteKey,
  ordinal: number,
): Promise<SuiteCaseRow | undefined> {
  const found = await drizzle(client)
    .select()
    .from(workflowTestSuiteCases)
    .where(and(inSuite(suite), eq(workflowTestSuiteCases.ordinal, ordinal)))
    .catch(rethrowQueryFailure);
  return found[0];
}

/** The suite's first case in this status, by position. */
export async function readFirstCaseIn(
  client: PoolClient,
  suite: SuiteKey,
  status: SuiteCaseRow['status'],
): Promise<SuiteCaseRow | undefined> {
  const found = await drizzle(client)
    .select()
    .from(workflowTestSuiteCases)
    .where(and(inSuite(suite), eq(workflowTestSuiteCases.status, status)))
    .orderBy(asc(workflowTestSuiteCases.ordinal))
    .limit(1)
    .catch(rethrowQueryFailure);
  return found[0];
}

/**
 * The run of the suite's running case: undefined when no case runs, null when
 * it runs without a run.
 */
export async function readRunningCaseRunId(
  client: PoolClient,
  suite: SuiteKey,
): Promise<string | null | undefined> {
  const active = await drizzle(client)
    .select({ runId: workflowTestSuiteCases.runId })
    .from(workflowTestSuiteCases)
    .where(and(inSuite(suite), eq(workflowTestSuiteCases.status, 'running')))
    .catch(rethrowQueryFailure);
  return active[0]?.runId;
}

/** How many of the suite's cases did not pass. */
export async function countNonpassingCases(
  client: PoolClient,
  suite: SuiteKey,
): Promise<number | undefined> {
  const remaining = await drizzle(client)
    .select({ nonpassing: sql<number>`count(*)::integer` })
    .from(workflowTestSuiteCases)
    .where(and(inSuite(suite), ne(workflowTestSuiteCases.status, 'passed')))
    .catch(rethrowQueryFailure);
  return remaining[0]?.nonpassing;
}

/** Sets a case's status, and its report when it has one. */
export async function settleSuiteCase(
  client: PoolClient,
  suite: SuiteKey,
  ordinal: number,
  result: Readonly<{ status: SuiteCaseRow['status']; report?: string }>,
): Promise<void> {
  await drizzle(client)
    .update(workflowTestSuiteCases)
    .set(result)
    .where(and(inSuite(suite), eq(workflowTestSuiteCases.ordinal, ordinal)))
    .catch(rethrowQueryFailure);
}

/** A pending case starts running with its admitted run; false if it was not pending. */
export async function startPendingCase(
  client: PoolClient,
  suite: SuiteKey,
  ordinal: number,
  runId: string,
): Promise<boolean> {
  const changed = await drizzle(client)
    .update(workflowTestSuiteCases)
    .set({ runId, status: 'running' })
    .where(
      and(
        inSuite(suite),
        eq(workflowTestSuiteCases.ordinal, ordinal),
        eq(workflowTestSuiteCases.status, 'pending'),
      ),
    )
    .returning({ ordinal: workflowTestSuiteCases.ordinal })
    .catch(rethrowQueryFailure);
  return changed.length === 1;
}
