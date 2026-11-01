import type { WorkflowTestSuiteReport } from '@pertexo/contracts';
import {
  evaluateSuiteExpectations,
  type SuiteOutput,
} from '@pertexo/workflow-engine';
import {
  workflowTestExpectationsSchema,
  type JsonValue,
} from '@pertexo/workflow-model';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { parseStoredExecutionValue } from '../../runs/values/stored-execution.js';
import { testRunSql } from '../../runs/data-policy.js';
import {
  nodeRuns,
  workflowRuns,
  workflowTestSnapshots,
} from '@pertexo/database/schema';
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
  const expectations = workflowTestExpectationsSchema.parse(
    JSON.parse(entry.expectations),
  );
  const outputs = new Map<string, SuiteOutput>();
  const inline = (
    stored: unknown,
  ): { state: 'value'; value: JsonValue } | { state: 'unavailable' } => {
    if (stored === null) return { state: 'unavailable' };
    const value = parseStoredExecutionValue(stored);
    return value.kind === 'inline'
      ? { state: 'value', value: value.value }
      : { state: 'unavailable' };
  };
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
  }
  return evaluateSuiteExpectations(expectations, run, outputs);
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
