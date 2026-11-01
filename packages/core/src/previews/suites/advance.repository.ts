import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflowTestSuites,
  workflowTestSuiteCases,
  workspaces,
  workflows,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { canonicalJson } from '@pertexo/workflow-model';
import { WorkflowNotFoundError } from '../../authoring/workflows/errors.js';
import { lockWorkflowAuthoringAuthority } from '../../authoring/workflows/authority.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import {
  WorkspaceRunQuotaExceededError,
  WorkspaceRunAdmissionDeniedError,
} from '../../runs/commands/acceptance/errors.js';
import { lockTestAuthority } from '../workflows/authority.queries.js';
import type { SuiteRow, SuiteCaseRow } from './contract.js';
import { admitSuiteCase } from './admit.repository.js';
import { evaluateSuiteCase, readSuiteRunOutcome } from './evaluate.queries.js';

async function stop(
  client: PoolClient,
  suite: SuiteRow,
  reason: string,
): Promise<void> {
  await drizzle(client)
    .update(workflowTestSuites)
    .set({
      stopReason: sql`coalesce(${workflowTestSuites.stopReason},${reason})`,
    })
    .where(
      and(
        eq(workflowTestSuites.workspaceId, suite.workspaceId),
        eq(workflowTestSuites.id, suite.id),
      ),
    )
    .catch(rethrowQueryFailure);
  suite.stopReason ??= reason;
  await drizzle(client)
    .update(workflowTestSuiteCases)
    .set({ status: 'skipped' })
    .where(
      and(
        eq(workflowTestSuiteCases.workspaceId, suite.workspaceId),
        eq(workflowTestSuiteCases.suiteId, suite.id),
        eq(workflowTestSuiteCases.status, 'pending'),
      ),
    )
    .catch(rethrowQueryFailure);
}
async function finish(client: PoolClient, suite: SuiteRow): Promise<void> {
  const remaining = await drizzle(client)
    .select({ nonpassing: sql<number>`count(*)::integer` })
    .from(workflowTestSuiteCases)
    .where(
      and(
        eq(workflowTestSuiteCases.workspaceId, suite.workspaceId),
        eq(workflowTestSuiteCases.suiteId, suite.id),
        ne(workflowTestSuiteCases.status, 'passed'),
      ),
    )
    .catch(rethrowQueryFailure);
  const status = suiteOutcome(suite, remaining[0]?.nonpassing);
  await drizzle(client)
    .update(workflowTestSuites)
    .set({ status, completedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(workflowTestSuites.workspaceId, suite.workspaceId),
        eq(workflowTestSuites.id, suite.id),
      ),
    )
    .catch(rethrowQueryFailure);
}
/** Called after the workspace fence; never from a transaction holding a run row. */
export async function advanceSuite(
  client: PoolClient,
  candidate: Pick<SuiteRow, 'workspaceId' | 'workflowId' | 'startedBy' | 'id'>,
): Promise<boolean> {
  const db = drizzle(client);
  const workspace = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, candidate.workspaceId))
    .for('share')
    .catch(rethrowQueryFailure);
  if (workspace.length !== 1) return false;
  let allowed = true;
  const scope = {
    workspaceId: candidate.workspaceId,
    workflowId: candidate.workflowId,
    actorId: candidate.startedBy,
  };
  try {
    await lockTestAuthority(client, scope);
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) allowed = false;
    else throw error;
  }
  const workflow = await db
    .select({ lifecycleStatus: workflows.lifecycleStatus })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, candidate.workspaceId),
        eq(workflows.id, candidate.workflowId),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  const found = await db
    .select()
    .from(workflowTestSuites)
    .where(
      and(
        eq(workflowTestSuites.workspaceId, candidate.workspaceId),
        eq(workflowTestSuites.id, candidate.id),
        eq(workflowTestSuites.status, 'running'),
        sql`${workflowTestSuites.expiresAt}>clock_timestamp()`,
        sql`${workflowTestSuites.nextCheckAt}<=clock_timestamp()`,
      ),
    )
    .for('update', { skipLocked: true })
    .catch(rethrowQueryFailure);
  const suite = found[0];
  if (suite === undefined) return false;
  if (allowed && suite.usesConnections)
    try {
      await lockWorkflowAuthoringAuthority(client, suite.workspaceId, {
        actorId: suite.startedBy,
        roles: rolesForCapability('connection:use'),
      });
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) allowed = false;
      else throw error;
    }
  const clock = await db
    .execute<{ now: string }>(sql`select clock_timestamp() now`)
    .catch(rethrowQueryFailure);
  const databaseTime = clock.rows[0]?.now;
  if (databaseTime === undefined) throw new Error('Suite clock is unavailable');
  const now = new Date(databaseTime);
  if (!allowed) await stop(client, suite, 'authority_lost');
  else if (workflow[0]?.lifecycleStatus !== 'active')
    await stop(client, suite, 'workflow_archived');
  if (now >= suite.deadlineAt) await stop(client, suite, 'deadline_exceeded');
  if (suite.cancelRequested) await stop(client, suite, 'user_canceled');
  const active = await db
    .select()
    .from(workflowTestSuiteCases)
    .where(
      and(
        eq(workflowTestSuiteCases.workspaceId, suite.workspaceId),
        eq(workflowTestSuiteCases.suiteId, suite.id),
        eq(workflowTestSuiteCases.status, 'running'),
      ),
    )
    .orderBy(asc(workflowTestSuiteCases.ordinal))
    .limit(1)
    .catch(rethrowQueryFailure);
  const entry = active[0];
  if (
    entry !== undefined &&
    (await completeActiveSuiteCase(client, suite, entry))
  )
    return true;
  if (suite.stopReason !== null) {
    await finish(client, suite);
    return true;
  }
  const pending = await db
    .select()
    .from(workflowTestSuiteCases)
    .where(
      and(
        eq(workflowTestSuiteCases.workspaceId, suite.workspaceId),
        eq(workflowTestSuiteCases.suiteId, suite.id),
        eq(workflowTestSuiteCases.status, 'pending'),
      ),
    )
    .orderBy(asc(workflowTestSuiteCases.ordinal))
    .limit(1)
    .catch(rethrowQueryFailure);
  const next = pending[0];
  if (next === undefined) {
    await finish(client, suite);
    return true;
  }
  await admitNextSuiteCase(client, suite, next, now);
  return true;
}

function suiteOutcome(
  suite: SuiteRow,
  nonpassing: number | undefined,
): 'canceled' | 'error' | 'passed' | 'failed' {
  if (
    suite.stopReason === 'user_canceled' ||
    suite.stopReason === 'case_canceled'
  ) {
    return 'canceled';
  }
  if (suite.stopReason !== null) {
    return 'error';
  }
  if (nonpassing === 0) {
    return 'passed';
  }
  return 'failed';
}

async function completeActiveSuiteCase(
  client: PoolClient,
  suite: SuiteRow,
  entry: SuiteCaseRow,
): Promise<boolean> {
  const run =
    entry.runId === null
      ? undefined
      : await readSuiteRunOutcome(
          client,
          suite.workspaceId,
          entry.runId,
          suite.snapshotId,
        );
  if (run === undefined) {
    await stop(client, suite, 'run_unavailable');
    await drizzle(client)
      .update(workflowTestSuiteCases)
      .set({ status: 'error' })
      .where(
        and(
          eq(workflowTestSuiteCases.workspaceId, suite.workspaceId),
          eq(workflowTestSuiteCases.suiteId, suite.id),
          eq(workflowTestSuiteCases.ordinal, entry.ordinal),
        ),
      )
      .catch(rethrowQueryFailure);
  } else if (['queued', 'running', 'waiting'].includes(run.status)) {
    await drizzle(client)
      .update(workflowTestSuites)
      .set({ nextCheckAt: sql`clock_timestamp()+interval '1 second'` })
      .where(
        and(
          eq(workflowTestSuites.workspaceId, suite.workspaceId),
          eq(workflowTestSuites.id, suite.id),
        ),
      )
      .catch(rethrowQueryFailure);
    return true;
  } else {
    const result = await evaluateSuiteCase(client, entry, run);
    await drizzle(client)
      .update(workflowTestSuiteCases)
      .set({ status: result.status, report: canonicalJson(result.report) })
      .where(
        and(
          eq(workflowTestSuiteCases.workspaceId, suite.workspaceId),
          eq(workflowTestSuiteCases.suiteId, suite.id),
          eq(workflowTestSuiteCases.ordinal, entry.ordinal),
        ),
      )
      .catch(rethrowQueryFailure);
    if (run.status === 'canceled') await stop(client, suite, 'case_canceled');
  }

  return false;
}

async function admitNextSuiteCase(
  client: PoolClient,
  suite: SuiteRow,
  next: SuiteCaseRow,
  now: Date,
): Promise<void> {
  await drizzle(client)
    .execute(sql`savepoint suite_case_admission`)
    .catch(rethrowQueryFailure);
  try {
    await admitSuiteCase(client, suite, next, now);
    await drizzle(client)
      .execute(sql`release savepoint suite_case_admission`)
      .catch(rethrowQueryFailure);
    await drizzle(client)
      .update(workflowTestSuites)
      .set({ nextCheckAt: sql`clock_timestamp()+interval '1 second'` })
      .where(
        and(
          eq(workflowTestSuites.workspaceId, suite.workspaceId),
          eq(workflowTestSuites.id, suite.id),
        ),
      )
      .catch(rethrowQueryFailure);
  } catch (error) {
    await drizzle(client)
      .execute(sql`rollback to savepoint suite_case_admission`)
      .catch(rethrowQueryFailure);
    if (error instanceof WorkspaceRunQuotaExceededError)
      await drizzle(client)
        .update(workflowTestSuites)
        .set({ nextCheckAt: sql`clock_timestamp()+interval '5 seconds'` })
        .where(
          and(
            eq(workflowTestSuites.workspaceId, suite.workspaceId),
            eq(workflowTestSuites.id, suite.id),
          ),
        )
        .catch(rethrowQueryFailure);
    else if (error instanceof WorkspaceRunAdmissionDeniedError) {
      await stop(client, suite, 'admission_denied');
      await finish(client, suite);
    } else throw error;
  }
}
