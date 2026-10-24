import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { nodeRuns, workflowRuns } from '../../schema/runs/execution.js';
import { workflowTestSnapshots } from '../../schema/runs/tests.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
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
  outputRef: unknown;
  pinRequired: boolean;
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
  const error = suiteRunError(run);
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
      if (assertion.source.kind === 'final') output = inline(run.outputRef);
      else {
        const rows = await drizzle(client)
          .select({ status: nodeRuns.status, outputRef: nodeRuns.outputRef })
          .from(nodeRuns)
          .where(
            and(
              eq(nodeRuns.workspaceId, entry.workspaceId),
              sql`${nodeRuns.workflowRunId}=${entry.runId}`,
              eq(nodeRuns.nodeId, assertion.source.nodeId),
            ),
          )
          .orderBy(asc(nodeRuns.id))
          .limit(2)
          .catch(rethrowQueryFailure);
        const one = rows[0];
        if (rows.length > 1) output = { state: 'ambiguous' };
        else if (one?.status === 'succeeded') output = inline(one.outputRef);
        else output = { state: 'unavailable' };
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
    status: suiteCaseStatus({ error, outcomeMatched, assertions }),
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
  const run = alias(workflowRuns, 'run');
  const found = await drizzle(client)
    .select({
      status: run.status,
      outputRef: run.outputRef,
      dispositions: workflowTestSnapshots.dispositions,
    })
    .from(run)
    .innerJoin(
      workflowTestSnapshots,
      and(
        eq(workflowTestSnapshots.workspaceId, run.workspaceId),
        eq(workflowTestSnapshots.id, run.workflowVersionId),
      ),
    )
    .where(
      and(
        eq(run.workspaceId, workspaceId),
        eq(run.id, runId),
        eq(workflowTestSnapshots.id, snapshotId),
        testRunSql('run'),
      ),
    )
    .catch(rethrowQueryFailure);
  const row = found[0];
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
      outputRef: row.outputRef,
      pinRequired: false,
    };
  const problem = await drizzle(client)
    .select({ id: nodeRuns.id })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.workspaceId, workspaceId),
        eq(nodeRuns.workflowRunId, runId),
        inArray(nodeRuns.nodeId, required),
        eq(nodeRuns.safeErrorCode, 'test.pin_required'),
      ),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  return {
    status: row.status,
    outputRef: row.outputRef,
    pinRequired: problem.length !== 0,
  };
}

function suiteRunError(run: SuiteRunOutcome): WorkflowTestSuiteReport['error'] {
  if (run.pinRequired) {
    return 'test_pin_required';
  }
  if (run.status === 'timed_out') {
    return 'run_timed_out';
  }
  if (run.status === 'outcome_unknown') {
    return 'run_outcome_unknown';
  }
  if (run.status === 'canceled') {
    return 'run_canceled';
  }
  return undefined;
}

function suiteCaseStatus(
  input: Readonly<{
    error: WorkflowTestSuiteReport['error'];
    outcomeMatched: boolean;
    assertions: WorkflowTestSuiteReport['assertions'];
  }>,
): 'error' | 'passed' | 'failed' {
  const { error, outcomeMatched, assertions } = input;
  if (error !== undefined) {
    return 'error';
  }
  if (outcomeMatched && assertions.every((item) => item.actual.matched)) {
    return 'passed';
  }
  return 'failed';
}
