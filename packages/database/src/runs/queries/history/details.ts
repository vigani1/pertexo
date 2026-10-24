import { withResourceRunRead } from '../../../tenant-access/resources/transactions.js';
import {
  retainedTestRunSql,
  runRetentionIntervalSql,
  RUN_DETAILS_RETENTION_SQL,
} from '../../data-policy.js';
import { codeDiagnosticsSchema, type CodeDiagnostics } from '@pertexo/node-sdk';
import { readVariableSetValues } from '../../../variables/values.queries.js';
import type { WorkspaceVariableSnapshot } from '@pertexo/workflow-model';
import { sql, and, eq } from 'drizzle-orm';
import { workflowRuns } from '../../../schema/runs/execution.js';
import { alias } from 'drizzle-orm/pg-core';
import { workflowGraphStepSql } from '../execution/graph-step.js';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { WorkspaceTransaction } from '../../../tenant-access/transactions.js';
import {
  parseStoredExecutionValue,
  type StoredExecutionJsonValue,
} from '../../../platform/stored-execution-value.js';

/**
 * A run's input or a node run's output as stored (ADR 050). `expired` is a
 * run input past its 30-day window, which retention clears.
 */
export type WorkflowRunData =
  | Readonly<{ kind: 'inline'; value: StoredExecutionJsonValue }>
  | Readonly<{ kind: 'artifact'; artifactId: string }>
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'expired' }>;

/** The step that explains an unsuccessful run, named from its version. */
export type WorkflowRunFailedStep = Readonly<{
  nodeId: string;
  label: string | null;
  definitionKey: string | null;
  safeErrorCode: string | null;
}>;

const runDataInputSchema = z
  .object({
    workspaceId: z.uuid(),
    actorId: z.uuid(),
    runId: z.uuid(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();
const nodeRunDataInputSchema = runDataInputSchema
  .extend({ nodeRunId: z.uuid() })
  .strict();

export type ReadWorkflowRunInputInput = Readonly<
  z.input<typeof runDataInputSchema>
>;
export type ReadWorkflowNodeRunOutputInput = Readonly<
  z.input<typeof nodeRunDataInputSchema>
>;

const inputRowSchema = z
  .object({ input_ref: z.unknown(), past_input_window: z.boolean() })
  .strict();
const storedRowSchema = z.object({ stored: z.unknown() }).strict();
const failedStepRowSchema = z
  .object({
    workflow_run_id: z.uuid(),
    node_id: z.string().min(1).max(256),
    label: z.string().min(1).max(200).nullable(),
    definition_key: z.string().min(1).max(256).nullable(),
    safe_error_code: z.string().min(1).max(128).nullable(),
  })
  .strict();

function toRunData(stored: unknown): WorkflowRunData {
  const value = parseStoredExecutionValue(stored);
  return value.kind === 'inline'
    ? Object.freeze({ kind: 'inline', value: value.value })
    : Object.freeze({ kind: 'artifact', artifactId: value.artifactId });
}

/** The input a run started with; `undefined` when the run is not visible. */
export async function readWorkflowRunInput(
  pool: Pool,
  input: ReadWorkflowRunInputInput,
): Promise<WorkflowRunData | undefined> {
  const parsed = runDataInputSchema.parse(input);
  return withResourceRunRead(pool, parsed, (transaction) =>
    runInputInTransaction(transaction, parsed.runId),
  );
}

/**
 * The input a node run's latest attempt received, as recorded (ADR 052);
 * `undefined` unless it belongs to the run.
 */
export async function readWorkflowNodeRunInput(
  pool: Pool,
  input: ReadWorkflowNodeRunOutputInput,
): Promise<WorkflowRunData | undefined> {
  const parsed = nodeRunDataInputSchema.parse(input);
  return withResourceRunRead(pool, parsed, (transaction) =>
    nodeRunValueInTransaction(
      transaction,
      parsed.runId,
      parsed.nodeRunId,
      'input',
    ),
  );
}

/** A node run's current output; `undefined` unless it belongs to the run. */
export async function readWorkflowNodeRunOutput(
  pool: Pool,
  input: ReadWorkflowNodeRunOutputInput,
): Promise<WorkflowRunData | undefined> {
  const parsed = nodeRunDataInputSchema.parse(input);
  return withResourceRunRead(pool, parsed, (transaction) =>
    nodeRunValueInTransaction(
      transaction,
      parsed.runId,
      parsed.nodeRunId,
      'output',
    ),
  );
}

export async function runInputInTransaction(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<WorkflowRunData | undefined> {
  const result = await transaction.db.execute(sql`
    select
      case when ${retainedTestRunSql()} then input_ref else null end as input_ref,
      created_at <= statement_timestamp() - ${runRetentionIntervalSql()}
        as past_input_window
    from app.workflow_runs
    where workspace_id = ${transaction.workspaceId} and id = ${runId}
    limit 1
  `);
  if (result.rows[0] === undefined) return undefined;
  const row = inputRowSchema.parse(result.rows[0]);
  if (row.input_ref !== null) return toRunData(row.input_ref);
  // Retention clears an input the same way a run without one looks.
  return Object.freeze({ kind: row.past_input_window ? 'expired' : 'none' });
}

/** A node run's stored input or output; `undefined` unless it's in the run. */
async function nodeRunValueInTransaction(
  transaction: WorkspaceTransaction,
  runId: string,
  nodeRunId: string,
  value: 'input' | 'output',
): Promise<WorkflowRunData | undefined> {
  const column = sql.raw(value === 'input' ? 'input_ref' : 'output_ref');
  const result = await transaction.db.execute(sql`
    select ${column} as stored
    from app.node_runs
    where exists(select 1 from app.workflow_runs run where run.workspace_id=app.node_runs.workspace_id and run.id=app.node_runs.workflow_run_id and ${retainedTestRunSql('run')})
      and workspace_id = ${transaction.workspaceId}
      and workflow_run_id = ${runId}
      and id = ${nodeRunId}
    limit 1
  `);
  if (result.rows[0] === undefined) return undefined;
  const row = storedRowSchema.parse(result.rows[0]);
  return row.stored === null
    ? Object.freeze({ kind: 'none' })
    : toRunData(row.stored);
}

/**
 * For each run, the most recently completed step that failed, timed out or
 * ended with an unknown outcome, named by its label and definition in the
 * run's version. Steps inside loops are nested in the graph, so the lookup
 * searches every level.
 */
export async function readWorkflowRunFailedSteps(
  transaction: WorkspaceTransaction,
  runIds: readonly string[],
): Promise<ReadonlyMap<string, WorkflowRunFailedStep>> {
  if (runIds.length === 0) return new Map();
  const ids = `{${runIds.map((id) => z.uuid().parse(id)).join(',')}}`;
  const result = await transaction.db.execute(sql`
    select distinct on (node.workflow_run_id)
      node.workflow_run_id,
      node.node_id,
      left(nullif(btrim(graph_node.value ->> 'label'), ''), 200) as label,
      left(graph_node.value -> 'definition' ->> 'key', 256) as definition_key,
      node.safe_error_code
    from app.node_runs node
    join app.workflow_runs run
      on run.workspace_id = node.workspace_id
     and run.id = node.workflow_run_id
    left join app.workflow_versions version
      on version.workspace_id = run.workspace_id
     and version.id = run.workflow_version_id
    left join lateral (${sql.raw(workflowGraphStepSql('version.graph_json', 'node.node_id'))}) graph_node on true
    where node.workspace_id = ${transaction.workspaceId}
      and node.workflow_run_id = any(${ids}::uuid[])
      and node.status in ('failed', 'timed_out', 'outcome_unknown')
      and node.failure_handling is distinct from 'handled'
    order by
      node.workflow_run_id,
      node.completed_at desc nulls last,
      node.id desc
  `);
  const steps = new Map<string, WorkflowRunFailedStep>();
  for (const value of result.rows) {
    const row = failedStepRowSchema.parse(value);
    steps.set(
      row.workflow_run_id,
      Object.freeze({
        nodeId: row.node_id,
        label: row.label,
        definitionKey: row.definition_key,
        safeErrorCode: row.safe_error_code,
      }),
    );
  }
  return steps;
}

/** Retained non-secret configuration uses the same authorization and logical detail window as run data. */
export async function readWorkflowRunVariables(
  pool: Pool,
  input: ReadWorkflowRunInputInput,
): Promise<WorkspaceVariableSnapshot | null | undefined> {
  const parsed = runDataInputSchema.parse(input);
  return withResourceRunRead(pool, parsed, async (transaction) => {
    const run = alias(workflowRuns, 'run');
    const [row] = await transaction.db
      .select({
        revision: run.variableSetRevision,
        retained: sql<boolean>`(${run.detailsPurgedAt} IS NULL AND (${run.completedAt} IS NULL OR ${run.completedAt}>clock_timestamp()-${RUN_DETAILS_RETENTION_SQL}) AND ${retainedTestRunSql('run', 'clock_timestamp()')})`,
      })
      .from(run)
      .where(
        and(
          eq(run.workspaceId, transaction.workspaceId),
          eq(run.id, parsed.runId),
        ),
      );

    if (row === undefined) return undefined;
    if (!row.retained) return null;
    return {
      revision: row.revision ?? 0,
      values: await readVariableSetValues(
        transaction.db,
        transaction.workspaceId,
        row.revision,
      ),
    };
  });
}

/** Private diagnostics follow the current attempt and the logical detail window. */
export async function readWorkflowNodeRunDiagnostics(
  pool: Pool,
  input: ReadWorkflowNodeRunOutputInput,
): Promise<CodeDiagnostics | null | undefined> {
  const parsed = nodeRunDataInputSchema.parse(input);
  return withResourceRunRead(pool, parsed, async (transaction) => {
    const result = await transaction.db.execute<{ diagnostics: unknown }>(sql`
      select case when run.details_purged_at is null
        and (run.completed_at is null or run.completed_at > statement_timestamp() - ${RUN_DETAILS_RETENTION_SQL})
        and ${retainedTestRunSql('run')}
        then attempt.code_diagnostics else null end as diagnostics
      from app.node_runs node
      join app.workflow_runs run on run.workspace_id = node.workspace_id and run.id = node.workflow_run_id
      left join app.node_attempts attempt on attempt.workspace_id = node.workspace_id
        and attempt.node_run_id = node.id and attempt.id = node.current_attempt_id
      where node.workspace_id = ${transaction.workspaceId}
        and node.workflow_run_id = ${parsed.runId} and node.id = ${parsed.nodeRunId}
      limit 1
    `);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return row.diagnostics === null
      ? null
      : codeDiagnosticsSchema.parse(row.diagnostics);
  });
}
