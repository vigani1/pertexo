import type { PoolClient } from 'pg';
import { canonicalJson } from '@pertexo/workflow-model';
import { WorkflowNotFoundError } from '../../authoring/workflows/errors.js';
import { lockWorkflowAuthoringAuthority } from '../../authoring/workflows/authority.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import {
  WorkspaceRunQuotaExceededError,
  WorkspaceRunAdmissionDeniedError,
} from '../../runs/commands/acceptance.js';
import { lockTestAuthority } from '../workflows/authority.queries.js';
import type { SuiteRow, SuiteCaseRow } from './contract.js';
import { admitSuiteCase } from './admit.repository.js';
import { evaluateSuiteCase, readSuiteRunOutcome } from './evaluate.queries.js';

async function stop(
  client: PoolClient,
  suite: SuiteRow,
  reason: string,
): Promise<void> {
  await client.query(
    'update app.workflow_test_suites set stop_reason=coalesce(stop_reason,$3) where workspace_id=$1 and id=$2',
    [suite.workspace_id, suite.id, reason],
  );
  suite.stop_reason ??= reason;
  await client.query(
    "update app.workflow_test_suite_cases set status='skipped' where workspace_id=$1 and suite_id=$2 and status='pending'",
    [suite.workspace_id, suite.id],
  );
}
async function finish(client: PoolClient, suite: SuiteRow): Promise<void> {
  const remaining = await client.query<{ nonpassing: number }>(
    "select count(*)::integer nonpassing from app.workflow_test_suite_cases where workspace_id=$1 and suite_id=$2 and status<>'passed'",
    [suite.workspace_id, suite.id],
  );
  const status = suiteOutcome(suite, remaining.rows[0]?.nonpassing);
  await client.query(
    'update app.workflow_test_suites set status=$3,completed_at=clock_timestamp() where workspace_id=$1 and id=$2',
    [suite.workspace_id, suite.id, status],
  );
}
/** Called after the workspace fence; never from a transaction holding a run row. */
export async function advanceSuite(
  client: PoolClient,
  candidate: {
    workspace_id: string;
    workflow_id: string;
    started_by: string;
    id: string;
  },
): Promise<boolean> {
  const workspace = await client.query(
    'select id from app.workspaces where id=$1 for share',
    [candidate.workspace_id],
  );
  if (workspace.rowCount !== 1) return false;
  let allowed = true;
  const scope = {
    workspaceId: candidate.workspace_id,
    workflowId: candidate.workflow_id,
    actorId: candidate.started_by,
  };
  try {
    await lockTestAuthority(client, scope);
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) allowed = false;
    else throw error;
  }
  const workflow = await client.query<{ lifecycle_status: string }>(
    'select lifecycle_status from app.workflows where workspace_id=$1 and id=$2 for share',
    [candidate.workspace_id, candidate.workflow_id],
  );
  const found = await client.query<SuiteRow>(
    "select * from app.workflow_test_suites where workspace_id=$1 and id=$2 and status='running' and expires_at>clock_timestamp() and next_check_at<=clock_timestamp() for update skip locked",
    [candidate.workspace_id, candidate.id],
  );
  const suite = found.rows[0];
  if (suite === undefined) return false;
  if (allowed && suite.uses_connections)
    try {
      await lockWorkflowAuthoringAuthority(client, suite.workspace_id, {
        actorId: suite.started_by,
        roles: rolesForCapability('connection:use'),
      });
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) allowed = false;
      else throw error;
    }
  const clock = await client.query<{ now: Date }>(
    'select clock_timestamp() now',
  );
  const now = clock.rows[0]?.now;
  if (now === undefined) throw new Error('Suite clock is unavailable');
  if (!allowed) await stop(client, suite, 'authority_lost');
  else if (workflow.rows[0]?.lifecycle_status !== 'active')
    await stop(client, suite, 'workflow_archived');
  if (now >= suite.deadline_at) await stop(client, suite, 'deadline_exceeded');
  if (suite.cancel_requested) await stop(client, suite, 'user_canceled');
  const active = await client.query<SuiteCaseRow>(
    "select * from app.workflow_test_suite_cases where workspace_id=$1 and suite_id=$2 and status='running' order by ordinal limit 1",
    [suite.workspace_id, suite.id],
  );
  const entry = active.rows[0];
  if (
    entry !== undefined &&
    (await completeActiveSuiteCase(client, suite, entry))
  )
    return true;
  if (suite.stop_reason !== null) {
    await finish(client, suite);
    return true;
  }
  const pending = await client.query<SuiteCaseRow>(
    "select * from app.workflow_test_suite_cases where workspace_id=$1 and suite_id=$2 and status='pending' order by ordinal limit 1",
    [suite.workspace_id, suite.id],
  );
  const next = pending.rows[0];
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
    suite.stop_reason === 'user_canceled' ||
    suite.stop_reason === 'case_canceled'
  ) {
    return 'canceled';
  }
  if (suite.stop_reason !== null) {
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
    entry.run_id === null
      ? undefined
      : await readSuiteRunOutcome(
          client,
          suite.workspace_id,
          entry.run_id,
          suite.snapshot_id,
        );
  if (run === undefined) {
    await stop(client, suite, 'run_unavailable');
    await client.query(
      "update app.workflow_test_suite_cases set status='error' where workspace_id=$1 and suite_id=$2 and ordinal=$3",
      [suite.workspace_id, suite.id, entry.ordinal],
    );
  } else if (['queued', 'running', 'waiting'].includes(run.status)) {
    await client.query(
      "update app.workflow_test_suites set next_check_at=clock_timestamp()+interval '1 second' where workspace_id=$1 and id=$2",
      [suite.workspace_id, suite.id],
    );
    return true;
  } else {
    const result = await evaluateSuiteCase(client, entry, run);
    await client.query(
      'update app.workflow_test_suite_cases set status=$4,report=$5 where workspace_id=$1 and suite_id=$2 and ordinal=$3',
      [
        suite.workspace_id,
        suite.id,
        entry.ordinal,
        result.status,
        canonicalJson(result.report),
      ],
    );
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
  await client.query('savepoint suite_case_admission');
  try {
    await admitSuiteCase(client, suite, next, now);
    await client.query('release savepoint suite_case_admission');
    await client.query(
      "update app.workflow_test_suites set next_check_at=clock_timestamp()+interval '1 second' where workspace_id=$1 and id=$2",
      [suite.workspace_id, suite.id],
    );
  } catch (error) {
    await client.query('rollback to savepoint suite_case_admission');
    if (error instanceof WorkspaceRunQuotaExceededError)
      await client.query(
        "update app.workflow_test_suites set next_check_at=clock_timestamp()+interval '5 seconds' where workspace_id=$1 and id=$2",
        [suite.workspace_id, suite.id],
      );
    else if (error instanceof WorkspaceRunAdmissionDeniedError) {
      await stop(client, suite, 'admission_denied');
      await finish(client, suite);
    } else throw error;
  }
}
