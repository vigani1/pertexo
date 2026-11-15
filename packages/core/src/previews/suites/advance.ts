import type { PoolClient } from 'pg';
import { canonicalJson } from '@pertexo/workflow-model';
import { WorkflowNotFoundError } from '../../authoring/workflows/workflow-authoring.errors.js';
import { lockWorkflowAuthoringAuthority } from '../../authoring/workflows/authority.js';
import { rolesForCapability } from '@pertexo/policy';
import {
  WorkspaceRunQuotaExceededError,
  WorkspaceRunAdmissionDeniedError,
} from '../../runs/commands/acceptance/run-admission.errors.js';
import { readDatabaseClock } from '../../shared/database-clock.repository.js';
import { lockTestAuthority } from '../workflows/access.js';
import { isActiveTestRun } from '../workflows/rules.js';
import type { SuiteRow, SuiteCaseRow } from './workflow-test-suite.types.js';
import { admitSuiteCase } from './admit.js';
import { suiteOutcome } from './rules.js';
import {
  countNonpassingCases,
  readFirstCaseIn,
  settleSuiteCase,
  skipPendingCases,
} from './cases.repository.js';
import {
  evaluateSuiteCase,
  readSuiteRunOutcome,
} from './evaluate.repository.js';
import {
  completeSuite,
  keepCaseAdmission,
  lockDueSuite,
  lockSuiteWorkflowStatus,
  lockSuiteWorkspace,
  openCaseAdmission,
  recordSuiteStopReason,
  scheduleSuiteCheck,
  undoCaseAdmission,
} from './suite-state.repository.js';

/** How soon a suite is checked again, in seconds. */
const SUITE_CHECK_AFTER_SECONDS = Object.freeze({
  // A case is running, or the next one was just admitted.
  next: 1,
  // The workspace has no room for another run yet.
  quotaFull: 5,
});

/** Called after the workspace fence; never from a transaction holding a run row. */
export async function advanceSuite(
  client: PoolClient,
  candidate: Pick<SuiteRow, 'workspaceId' | 'workflowId' | 'startedBy' | 'id'>,
): Promise<boolean> {
  if (!(await lockSuiteWorkspace(client, candidate.workspaceId))) return false;
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
  const workflowStatus = await lockSuiteWorkflowStatus(
    client,
    candidate.workspaceId,
    candidate.workflowId,
  );
  const suite = await lockDueSuite(client, candidate);
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
  const now = await readDatabaseClock(client);
  if (!allowed) await stop(client, suite, 'authority_lost');
  else if (workflowStatus !== 'active')
    await stop(client, suite, 'workflow_archived');
  if (now >= suite.deadlineAt) await stop(client, suite, 'deadline_exceeded');
  if (suite.cancelRequested) await stop(client, suite, 'user_canceled');
  const cases = { workspaceId: suite.workspaceId, suiteId: suite.id };
  const entry = await readFirstCaseIn(client, cases, 'running');
  if (
    entry !== undefined &&
    (await completeActiveSuiteCase(client, suite, entry))
  )
    return true;
  if (suite.stopReason !== null) {
    await finish(client, suite);
    return true;
  }
  const next = await readFirstCaseIn(client, cases, 'pending');
  if (next === undefined) {
    await finish(client, suite);
    return true;
  }
  await admitNextSuiteCase(client, suite, next, now);
  return true;
}

async function stop(
  client: PoolClient,
  suite: SuiteRow,
  reason: string,
): Promise<void> {
  await recordSuiteStopReason(client, suite, reason);
  suite.stopReason ??= reason;
  await skipPendingCases(client, suite.workspaceId, suite.id);
}

async function finish(client: PoolClient, suite: SuiteRow): Promise<void> {
  const nonpassing = await countNonpassingCases(client, {
    workspaceId: suite.workspaceId,
    suiteId: suite.id,
  });
  await completeSuite(client, suite, suiteOutcome(suite, nonpassing));
}

async function completeActiveSuiteCase(
  client: PoolClient,
  suite: SuiteRow,
  entry: SuiteCaseRow,
): Promise<boolean> {
  const cases = { workspaceId: suite.workspaceId, suiteId: suite.id };
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
    await settleSuiteCase(client, cases, entry.ordinal, { status: 'error' });
  } else if (isActiveTestRun(run.status)) {
    await scheduleSuiteCheck(client, suite, SUITE_CHECK_AFTER_SECONDS.next);
    return true;
  } else {
    const result = await evaluateSuiteCase(client, entry, run);
    await settleSuiteCase(client, cases, entry.ordinal, {
      status: result.status,
      report: canonicalJson(result.report),
    });
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
  await openCaseAdmission(client);
  try {
    await admitSuiteCase(client, suite, next, now);
    await keepCaseAdmission(client);
    await scheduleSuiteCheck(client, suite, SUITE_CHECK_AFTER_SECONDS.next);
  } catch (error) {
    await undoCaseAdmission(client);
    if (error instanceof WorkspaceRunQuotaExceededError)
      await scheduleSuiteCheck(
        client,
        suite,
        SUITE_CHECK_AFTER_SECONDS.quotaFull,
      );
    else if (error instanceof WorkspaceRunAdmissionDeniedError) {
      await stop(client, suite, 'admission_denied');
      await finish(client, suite);
    } else throw error;
  }
}
