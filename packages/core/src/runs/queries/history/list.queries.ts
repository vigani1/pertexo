import type { RunStatus } from '@pertexo/workflow-engine';
import { workflowScopeSql } from '../../../shared/scope.queries.js';
import type { ResourceTransaction } from '../../../shared/contract.js';
import { withRetainedRunRead } from '../../access.js';
import { ordinaryRunSql, expiredRunSql } from '../../data-policy.js';
import { UNSUCCESSFUL_STATUSES } from '../../statuses.js';
import {
  workflowRunValues,
  workflows,
  workflowRuns,
} from '@pertexo/database/schema';
import {
  workflowRunReadQuery,
  runAdmissionBlockers,
} from '../admission.queries.js';
import { and, desc, eq, lt, or, sql, type SQL } from 'drizzle-orm';
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
const EXPLAINED_BY_A_STEP: ReadonlySet<string> = new Set(UNSUCCESSFUL_STATUSES);

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
  return withRetainedRunRead(pool, input, async (transaction) =>
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
  const filters = and(
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
  );
  const result = await workflowRunReadQuery(transaction, {
    includeWorkflowName: input.includeWorkflowName ?? false,
  })
    .where(
      and(
        filters,
        input.includeWorkflowName === true &&
          input.workflowNamePrefix !== undefined
          ? newestRunsOfMatchingWorkflows(
              transaction,
              input.workflowNamePrefix,
              filters,
              input.limit + 1,
            )
          : undefined,
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
      .filter((run) => EXPLAINED_BY_A_STEP.has(run.status))
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

/**
 * Walks each matching workflow's own newest runs through its index, so a prefix that
 * matches most of a million runs reads a page per workflow rather than all of them.
 * The page can only come from these. The filters apply inside, or a workflow's newest
 * runs could all be filtered out afterwards.
 */
function newestRunsOfMatchingWorkflows(
  transaction: ResourceTransaction,
  prefix: string,
  filters: SQL | undefined,
  limit: number,
): SQL {
  const { db, workspaceId } = transaction;
  const newest = db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(filters, sql`${workflowRuns.workflowId}=matching.id`))
    .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
    .limit(limit);
  return sql`${workflowRuns.id} in (
    select newest.id from ${workflows} matching
    cross join lateral (${newest}) newest
    where matching.workspace_id=${workspaceId}
      and lower(matching.name) like lower(${escapeLikePattern(prefix)}::text) || '%' escape '\\'
  )`;
}

function escapeLikePattern(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}
