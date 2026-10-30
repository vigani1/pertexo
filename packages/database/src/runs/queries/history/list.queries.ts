import type { RunStatus } from '@pertexo/workflow-engine';
import { workflowScopeSql } from '../../../tenant-access/resources/scope.queries.js';
import type { ResourceTransaction } from '../../../tenant-access/resources/contract.js';
import { withRetainedResourceRead } from '../../../tenant-access/resources/transactions.repository.js';
import { ordinaryRunSql, expiredRunSql } from '../../data-policy.js';
import { workflowRunValues } from '../../../schema/runs/values.js';
import { workflows } from '../../../schema/authoring/workflows.js';
import { workflowRuns } from '../../../schema/runs/execution.js';
import {
  workflowRunReadQuery,
  runAdmissionBlockers,
} from '../admission.queries.js';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  readWorkflowRunFailedSteps,
  type WorkflowRunFailedStep,
} from './details.queries.js';
import {
  toWorkflowRunReadRecord,
  type WorkflowRunReadRecord,
} from '../../commands/records.repository.js';

/** Outcomes a step can explain; a canceled run explains itself. */
const UNSUCCESSFUL_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'timed_out',
  'outcome_unknown',
]);

export type WorkflowRunListPosition = Readonly<{
  createdAt: string;
  id: string;
}>;

export type ListWorkflowRunsDatabaseInput = Readonly<{
  workspaceId: string;
  actorId: string;
  limit: number;
  workflowId?: string;
  runValueKey?: string;
  runValue?: string;
  workflowNamePrefix?: string;
  includeWorkflowName?: boolean;
  status?: RunStatus;
  createdAtFrom?: string;
  createdAtBefore?: string;
  after?: WorkflowRunListPosition;
  signal?: AbortSignal;
}>;

/** A listed run, with the step that explains it when it didn't succeed. */
export type WorkflowRunListRecord = WorkflowRunReadRecord &
  Readonly<{ failedStep: WorkflowRunFailedStep | null }>;

export type WorkflowRunListPage = Readonly<{
  items: readonly WorkflowRunListRecord[];
  nextCursor?: WorkflowRunListPosition;
}>;

/** One newest-first page, read in a workspace-scoped snapshot. */
export async function readWorkflowRunListPage(
  pool: Pool,
  input: ListWorkflowRunsDatabaseInput,
): Promise<WorkflowRunListPage> {
  return withRetainedResourceRead(pool, input, async (transaction) =>
    listWorkflowRunsInTransaction(transaction, {
      limit: input.limit,
      ...(input.runValueKey === undefined
        ? {}
        : {
            runValueKey: input.runValueKey,
            ...(input.runValue === undefined
              ? {}
              : { runValue: input.runValue }),
          }),
      ...(input.workflowId === undefined
        ? {}
        : { workflowId: input.workflowId }),
      ...(input.workflowNamePrefix === undefined
        ? {}
        : { workflowNamePrefix: input.workflowNamePrefix }),
      includeWorkflowName: input.includeWorkflowName ?? false,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.createdAtFrom === undefined
        ? {}
        : { createdAtFrom: input.createdAtFrom }),
      ...(input.createdAtBefore === undefined
        ? {}
        : { createdAtBefore: input.createdAtBefore }),
      ...(input.after === undefined ? {} : { after: input.after }),
    }),
  );
}

async function listWorkflowRunsInTransaction(
  transaction: ResourceTransaction,
  input: Omit<
    ListWorkflowRunsDatabaseInput,
    'workspaceId' | 'actorId' | 'signal'
  >,
): Promise<WorkflowRunListPage> {
  const escapedPrefix =
    input.workflowNamePrefix === undefined
      ? null
      : escapeLikePattern(input.workflowNamePrefix);
  const result = await workflowRunReadQuery(transaction, {
    includeWorkflowName: input.includeWorkflowName ?? false,
  })
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        workflowScopeSql(transaction.resources, sql`workflow_runs.workflow_id`),
        ordinaryRunSql('workflow_runs'),
        input.runValueKey === undefined
          ? undefined
          : sql`not (${expiredRunSql('workflow_runs')}) and exists (
          select 1 from ${workflowRunValues} value
          where value.workspace_id=${workflowRuns.workspaceId} and value.workflow_run_id=${workflowRuns.id}
            and value.key=${input.runValueKey} and value.value=${input.runValue}
        )`,
        input.workflowId === undefined
          ? undefined
          : eq(workflowRuns.workflowId, input.workflowId),
        !input.includeWorkflowName || escapedPrefix === null
          ? undefined
          : sql`lower(${workflows.name}) like lower(${escapedPrefix}::text) || '%' escape '\\'`,
        input.status === undefined
          ? undefined
          : eq(workflowRuns.status, input.status),
        input.createdAtFrom === undefined
          ? undefined
          : sql`${workflowRuns.createdAt} >= ${input.createdAtFrom}::timestamptz`,
        input.createdAtBefore === undefined
          ? undefined
          : sql`${workflowRuns.createdAt} < ${input.createdAtBefore}::timestamptz`,
        input.after === undefined
          ? undefined
          : or(
              sql`${workflowRuns.createdAt} < ${input.after.createdAt}::timestamptz`,
              and(
                sql`${workflowRuns.createdAt} = ${input.after.createdAt}::timestamptz`,
                lt(workflowRuns.id, input.after.id),
              ),
            ),
      ),
    )
    .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
    .limit(input.limit + 1);
  const rows = result.map((row) => ({
    cursor: row.cursor,
    run: toWorkflowRunReadRecord({
      ...row.run,
      workflow_name: row.workflowName,
      admission_blockers: runAdmissionBlockers(row),
    }),
  }));
  const hasMore = rows.length > input.limit;
  const visible = rows.slice(0, input.limit);
  const last = visible.at(-1);
  const failedSteps = await readWorkflowRunFailedSteps(
    transaction,
    visible
      .map(({ run }) => run)
      .filter((run) => UNSUCCESSFUL_STATUSES.has(run.status))
      .map((run) => run.id),
  );
  return Object.freeze({
    items: Object.freeze(
      visible.map(({ run }) =>
        Object.freeze({ ...run, failedStep: failedSteps.get(run.id) ?? null }),
      ),
    ),
    ...(hasMore && last !== undefined
      ? {
          nextCursor: Object.freeze({
            createdAt: last.cursor,
            id: last.run.id,
          }),
        }
      : {}),
  });
}

function escapeLikePattern(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}
