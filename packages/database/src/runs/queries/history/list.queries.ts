import { workflowScopeSql } from '../../../tenant-access/resources/scope.queries.js';
import type { ResourceTransaction } from '../../../tenant-access/resources/contract.js';
import { withRetainedResourceRead } from '../../../tenant-access/resources/transactions.repository.js';
import { ordinaryRunSql, expiredRunSql } from '../../data-policy.js';
import { runValueKeySchema, runValueTextSchema } from '@pertexo/node-sdk';
import { workflowRunValues } from '../../../schema/runs/values.js';
import { workflows } from '../../../schema/authoring/workflows.js';
import { workflowRuns } from '../../../schema/runs/execution.js';
import {
  workflowRunReadQuery,
  runAdmissionBlockers,
} from '../admission.queries.js';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { z } from 'zod';

import {
  readWorkflowRunFailedSteps,
  type WorkflowRunFailedStep,
} from './details.queries.js';
import {
  toWorkflowRunReadRecord,
  type WorkflowRunReadRecord,
} from '../../commands/records.repository.js';

const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);
/** Outcomes a step can explain; a canceled run explains itself. */
const UNSUCCESSFUL_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'timed_out',
  'outcome_unknown',
]);
const timestampCursorSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);

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
  status?: z.output<typeof runStatusSchema>;
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

const inputSchema = z
  .object({
    workspaceId: z.uuid(),
    actorId: z.uuid(),
    limit: z.number().int().min(1).max(100),
    workflowId: z.uuid().optional(),
    runValueKey: runValueKeySchema.optional(),
    runValue: runValueTextSchema.optional(),
    workflowNamePrefix: z.string().trim().min(1).max(128).optional(),
    includeWorkflowName: z.boolean().default(false),
    status: runStatusSchema.optional(),
    createdAtFrom: z.iso.datetime({ offset: true }).optional(),
    createdAtBefore: z.iso.datetime({ offset: true }).optional(),
    after: z
      .object({ createdAt: timestampCursorSchema, id: z.uuid() })
      .strict()
      .optional(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();

/** One newest-first page, read in a workspace-scoped snapshot. */
export async function readWorkflowRunListPage(
  pool: Pool,
  input: ListWorkflowRunsDatabaseInput,
): Promise<WorkflowRunListPage> {
  const parsed = inputSchema.parse(input);
  return withRetainedResourceRead(pool, parsed, async (transaction) =>
    listWorkflowRunsInTransaction(transaction, {
      limit: parsed.limit,
      ...(parsed.runValueKey === undefined
        ? {}
        : {
            runValueKey: parsed.runValueKey,
            ...(parsed.runValue === undefined
              ? {}
              : { runValue: parsed.runValue }),
          }),
      ...(parsed.workflowId === undefined
        ? {}
        : { workflowId: parsed.workflowId }),
      ...(parsed.workflowNamePrefix === undefined
        ? {}
        : { workflowNamePrefix: parsed.workflowNamePrefix }),
      includeWorkflowName: parsed.includeWorkflowName,
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.createdAtFrom === undefined
        ? {}
        : { createdAtFrom: parsed.createdAtFrom }),
      ...(parsed.createdAtBefore === undefined
        ? {}
        : { createdAtBefore: parsed.createdAtBefore }),
      ...(parsed.after === undefined ? {} : { after: parsed.after }),
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
