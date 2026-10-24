import { workflowVersions } from '../../../schema/authoring/workflows.js';
import { nodeRuns, nodeAttempts } from '../../../schema/runs/execution.js';
import { withResourceRunRead } from '../../../tenant-access/resources/transactions.repository.js';
import {
  retainedTestRunSql,
  runRetentionIntervalSql,
  RUN_DETAILS_RETENTION_SQL,
} from '../../data-policy.js';
import { codeDiagnosticsSchema, type CodeDiagnostics } from '@pertexo/node-sdk';
import { readVariableSetValues } from '../../../variables/values.queries.js';
import type { WorkspaceVariableSnapshot } from '@pertexo/workflow-model';
import { sql, and, eq, desc, exists, inArray } from 'drizzle-orm';
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
  const [row] = await transaction.db
    .select({
      input_ref: sql<unknown>`case when ${retainedTestRunSql()} then ${workflowRuns.inputRef} else null end`,
      past_input_window: sql<boolean>`${workflowRuns.createdAt}<=statement_timestamp()-${runRetentionIntervalSql()}`,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, runId),
      ),
    )
    .limit(1);
  if (row === undefined) return undefined;
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
  const run = alias(workflowRuns, 'run');
  const visible = transaction.db
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.workspaceId, nodeRuns.workspaceId),
        eq(run.id, nodeRuns.workflowRunId),
        retainedTestRunSql('run'),
      ),
    );
  const [row] = await transaction.db
    .select({
      stored: value === 'input' ? nodeRuns.inputRef : nodeRuns.outputRef,
    })
    .from(nodeRuns)
    .where(
      and(
        exists(visible),
        eq(nodeRuns.workspaceId, transaction.workspaceId),
        eq(nodeRuns.workflowRunId, runId),
        eq(nodeRuns.id, nodeRunId),
      ),
    )
    .limit(1);
  if (row === undefined) return undefined;
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
  const node = alias(nodeRuns, 'node');
  const run = alias(workflowRuns, 'run');
  const version = alias(workflowVersions, 'version');
  const graph = sql`lateral (${workflowGraphStepSql(sql`${version.graphJson}`, sql`${node.nodeId}`)}) graph_node`;
  const result = await transaction.db
    .selectDistinctOn([node.workflowRunId], {
      workflow_run_id: node.workflowRunId,
      node_id: node.nodeId,
      label: sql<
        string | null
      >`left(nullif(btrim(graph_node.value->>'label'),''),200)`,
      definition_key: sql<
        string | null
      >`left(graph_node.value->'definition'->>'key',256)`,
      safe_error_code: node.safeErrorCode,
    })
    .from(node)
    .innerJoin(
      run,
      and(
        eq(run.workspaceId, node.workspaceId),
        eq(run.id, node.workflowRunId),
      ),
    )
    .leftJoin(
      version,
      and(
        eq(version.workspaceId, run.workspaceId),
        eq(version.id, run.workflowVersionId),
      ),
    )
    .leftJoin(graph, sql`true`)
    .where(
      and(
        eq(node.workspaceId, transaction.workspaceId),
        inArray(node.workflowRunId, [...runIds]),
        inArray(node.status, ['failed', 'timed_out', 'outcome_unknown']),
        sql`${node.failureHandling} is distinct from 'handled'`,
      ),
    )
    .orderBy(
      node.workflowRunId,
      sql`${node.completedAt} desc nulls last`,
      desc(node.id),
    );
  const steps = new Map<string, WorkflowRunFailedStep>();
  for (const row of result) {
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
    const node = alias(nodeRuns, 'node');
    const run = alias(workflowRuns, 'run');
    const attempt = alias(nodeAttempts, 'attempt');
    const [row] = await transaction.db
      .select({
        diagnostics: sql<unknown>`case when ${run.detailsPurgedAt} is null and (${run.completedAt} is null or ${run.completedAt}>statement_timestamp()-${RUN_DETAILS_RETENTION_SQL}) and ${retainedTestRunSql('run')} then ${attempt.codeDiagnostics} else null end`,
      })
      .from(node)
      .innerJoin(
        run,
        and(
          eq(run.workspaceId, node.workspaceId),
          eq(run.id, node.workflowRunId),
        ),
      )
      .leftJoin(
        attempt,
        and(
          eq(attempt.workspaceId, node.workspaceId),
          eq(attempt.nodeRunId, node.id),
          eq(attempt.id, node.currentAttemptId),
        ),
      )
      .where(
        and(
          eq(node.workspaceId, transaction.workspaceId),
          eq(node.workflowRunId, parsed.runId),
          eq(node.id, parsed.nodeRunId),
        ),
      )
      .limit(1);
    if (row === undefined) return undefined;
    return row.diagnostics === null
      ? null
      : codeDiagnosticsSchema.parse(row.diagnostics);
  });
}
