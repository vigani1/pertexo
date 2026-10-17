import { testRunSql } from '../../runs/data-policy.js';
import type { PoolClient } from 'pg';
import {
  observeTestAssertion,
  type TestAssertionObservation,
  type WorkflowTestExpectations,
  type JsonValue,
} from '@pertexo/workflow-model';
import type { WorkflowTestSuiteReport } from '@pertexo/contracts';
import { parseStoredExecutionValue } from '../../platform/stored-execution-value.js';
import type { SuiteCaseRow } from './contract.js';
export interface SuiteRunOutcome {
  status: WorkflowTestSuiteReport['actualOutcome'];
  output_ref: unknown;
  pin_required: boolean;
}
/** Fetch only selected outputs; repeated steps are reported rather than guessed. */
export async function evaluateSuiteCase(
  client: PoolClient,
  entry: SuiteCaseRow,
  run: SuiteRunOutcome,
): Promise<{
  status: 'passed' | 'failed' | 'error';
  report: WorkflowTestSuiteReport;
}> {
  const expectations = JSON.parse(
    entry.expectations,
  ) as WorkflowTestExpectations;
  const outcomeMatched =
    run.status ===
    (expectations.outcome === 'succeeds' ? 'succeeded' : 'failed');
  const error = run.pin_required
    ? 'test_pin_required'
    : run.status === 'timed_out'
      ? 'run_timed_out'
      : run.status === 'outcome_unknown'
        ? 'run_outcome_unknown'
        : run.status === 'canceled'
          ? 'run_canceled'
          : undefined;
  const outputs = new Map<
    string,
    | { state: 'value'; value: JsonValue }
    | { state: 'unavailable' | 'ambiguous' }
  >();
  const inline = (
    stored: unknown,
  ): { state: 'value'; value: JsonValue } | { state: 'unavailable' } => {
    if (stored === null) return { state: 'unavailable' };
    const value = parseStoredExecutionValue(stored);
    return value.kind === 'inline'
      ? { state: 'value', value: value.value }
      : { state: 'unavailable' };
  };
  const assertions: WorkflowTestSuiteReport['assertions'] = [];
  for (const assertion of expectations.assertions) {
    const key =
      assertion.source.kind === 'final'
        ? 'final'
        : `step:${assertion.source.nodeId}`;
    let output = outputs.get(key);
    if (output === undefined) {
      if (assertion.source.kind === 'final') output = inline(run.output_ref);
      else {
        const rows = await client.query<{
          status: string;
          output_ref: unknown;
        }>(
          'select status,output_ref from app.node_runs where workspace_id=$1 and workflow_run_id=$2 and node_id=$3 order by id limit 2',
          [entry.workspace_id, entry.run_id, assertion.source.nodeId],
        );
        const one = rows.rows[0];
        output =
          rows.rows.length > 1
            ? { state: 'ambiguous' }
            : one?.status === 'succeeded'
              ? inline(one.output_ref)
              : { state: 'unavailable' };
      }
      outputs.set(key, output);
    }
    const actual: TestAssertionObservation =
      output.state === 'value'
        ? observeTestAssertion(output.value, assertion)
        : { state: output.state, matched: false };
    assertions.push({ assertion, actual });
  }
  const report: WorkflowTestSuiteReport = {
    expectedOutcome: expectations.outcome,
    actualOutcome: run.status,
    outcomeMatched,
    ...(error === undefined ? {} : { error }),
    assertions,
  };
  return {
    status:
      error !== undefined
        ? 'error'
        : outcomeMatched && assertions.every((item) => item.actual.matched)
          ? 'passed'
          : 'failed',
    report,
  };
}

/** Pin-required checks use the frozen disposition keys and indexed step lookups. */
export async function readSuiteRunOutcome(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  snapshotId: string,
): Promise<SuiteRunOutcome | undefined> {
  const found = await client.query<{
    status: SuiteRunOutcome['status'];
    output_ref: unknown;
    dispositions: Record<string, string>;
  }>(
    `select run.status,run.output_ref,snapshot.dispositions from app.workflow_runs run
 join app.workflow_test_snapshots snapshot on snapshot.workspace_id=run.workspace_id and snapshot.id=run.workflow_version_id
 where run.workspace_id=$1 and run.id=$2 and snapshot.id=$3 and ${testRunSql('run')}`,
    [workspaceId, runId, snapshotId],
  );
  const row = found.rows[0];
  if (row === undefined) return undefined;
  const required = Object.entries(row.dispositions)
    .filter(([, kind]) => kind === 'pin_required')
    .map(([nodeId]) => nodeId);
  if (
    required.length === 0 ||
    ['queued', 'running', 'waiting'].includes(row.status)
  )
    return {
      status: row.status,
      output_ref: row.output_ref,
      pin_required: false,
    };
  const problem = await client.query<{ found: boolean }>(
    `select exists(select 1 from app.node_runs where workspace_id=$1 and workflow_run_id=$2 and node_id=any($3::varchar[]) and safe_error_code='test.pin_required') found`,
    [workspaceId, runId, required],
  );
  return {
    status: row.status,
    output_ref: row.output_ref,
    pin_required: problem.rows[0]?.found === true,
  };
}
