import type { ResourceTransaction } from '../../../tenant-access/resources/contract.js';
import { withRetainedResourceRead } from '../../../tenant-access/resources/transactions.repository.js';
import type { Pool } from 'pg';
import type { RunStatus } from '@pertexo/workflow-engine';
import { emptyRunCounts } from '../counts.js';
import {
  readStatisticsCounts,
  readWorkflowBreakdownRows,
} from './aggregate.queries.js';

// Exact run counts for one workspace snapshot (ADR 044). Every statement
// reads one bounded index range: the non-terminal statuses, or the runs
// created inside a fixed window.

type CurrentStatus = Extract<RunStatus, 'queued' | 'running' | 'waiting'>;

/** Windows are whole hours so daylight-saving changes never skew them. */
const WINDOW_HOURS = Object.freeze({ '1h': 1, '6h': 6, '24h': 24, '7d': 168 });
type Window = '1h' | '6h' | '24h' | '7d';
const WORKFLOW_RUN_STATISTICS_WORKFLOW_LIMIT = 50;
/** The read's cost ceiling: it never holds a pooled connection longer. */
const WORKFLOW_RUN_STATISTICS_STATEMENT_TIMEOUT_MILLIS = 2_000;

interface Input {
  workspaceId: string;
  actorId: string;
  window: Window;
  includeWorkflows?: boolean;
  includeWorkflowName?: boolean;
  signal?: AbortSignal | undefined;
}

export type WorkflowRunStatisticsDatabaseInput = Readonly<Input>;

export type WorkflowRunStatusCountRecord = Readonly<Record<RunStatus, number>>;

// Read projection combines stored columns with computed or joined fields.
export type WorkflowRunWorkflowStatisticsRecord = Readonly<{
  workflowId: string;
  workflowName: string | null;
  total: number;
  byStatus: WorkflowRunStatusCountRecord;
}>;

// Read projection combines stored columns with computed or joined fields.
export type WorkflowRunStatisticsRecord = Readonly<{
  asOf: string;
  current: Readonly<Record<CurrentStatus, number>>;
  window: Readonly<{
    duration: Window;
    createdAtFrom: string;
    createdAtBefore: string;
    total: number;
    skippedTriggerEvents?: number;
    coordinatedTriggerEvents?: number;
    byStatus: WorkflowRunStatusCountRecord;
  }>;
  workflows?: Readonly<{
    items: readonly WorkflowRunWorkflowStatisticsRecord[];
    truncated: boolean;
  }>;
}>;

export async function readWorkflowRunStatistics(
  pool: Pool,
  input: WorkflowRunStatisticsDatabaseInput,
): Promise<WorkflowRunStatisticsRecord> {
  return withRetainedResourceRead(
    pool,
    input,
    (transaction) => readInTransaction(transaction, input),
    WORKFLOW_RUN_STATISTICS_STATEMENT_TIMEOUT_MILLIS,
  );
}

async function readInTransaction(
  transaction: ResourceTransaction,
  input: Input,
): Promise<WorkflowRunStatisticsRecord> {
  const hours = WINDOW_HOURS[input.window];
  // The transaction timestamp is fixed for the whole snapshot, so every
  // statement below shares the same window bounds and asOf.
  const { current, statuses, skipped } = await readStatisticsCounts(
    transaction,
    hours,
  );
  const byStatus = emptyRunCounts();
  for (const row of statuses) byStatus[row.status] = row.run_count;
  return Object.freeze({
    asOf: current.as_of,
    current: Object.freeze({
      queued: current.queued,
      running: current.running,
      waiting: current.waiting,
    }),
    window: Object.freeze({
      duration: input.window,
      createdAtFrom: current.created_at_from,
      createdAtBefore: current.as_of,
      skippedTriggerEvents: skipped.count,
      coordinatedTriggerEvents: skipped.coordinated,
      total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      byStatus: Object.freeze(byStatus),
    }),
    ...(input.includeWorkflows
      ? { workflows: await readWorkflowBreakdown(transaction, input, hours) }
      : {}),
  });
}

/** The window's busiest workflows, with one extra row to detect truncation. */
async function readWorkflowBreakdown(
  transaction: ResourceTransaction,
  input: Input,
  hours: number,
): Promise<NonNullable<WorkflowRunStatisticsRecord['workflows']>> {
  const result = await readWorkflowBreakdownRows(transaction, {
    hours,
    includeWorkflowName: input.includeWorkflowName ?? false,
    limit: WORKFLOW_RUN_STATISTICS_WORKFLOW_LIMIT + 1,
  });
  const workflows = new Map<
    string,
    {
      workflowName: string | null;
      total: number;
      byStatus: Record<RunStatus, number>;
    }
  >();
  for (const row of result) {
    const known = workflows.get(row.workflow_id) ?? {
      workflowName: row.workflow_name,
      total: row.total,
      byStatus: emptyRunCounts(),
    };
    known.byStatus[row.status] = row.run_count;
    workflows.set(row.workflow_id, known);
  }
  const items = [...workflows.entries()].map(([workflowId, workflow]) =>
    Object.freeze({
      workflowId,
      workflowName: workflow.workflowName,
      total: workflow.total,
      byStatus: Object.freeze(workflow.byStatus),
    }),
  );
  return Object.freeze({
    items: Object.freeze(
      items.slice(0, WORKFLOW_RUN_STATISTICS_WORKFLOW_LIMIT),
    ),
    truncated: items.length > WORKFLOW_RUN_STATISTICS_WORKFLOW_LIMIT,
  });
}
