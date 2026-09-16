import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { WorkspaceTransaction } from '../tenant-access/workspace.js';
import {
  toWorkflowRunRecord,
  type WorkflowRunRecord,
} from './workflow-run-persistence-support.js';

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
const timestampCursorSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);

export type WorkflowRunListPosition = Readonly<{
  createdAt: string;
  id: string;
}>;

export type ListWorkflowRunsDatabaseInput = Readonly<{
  workspaceId: string;
  limit: number;
  workflowId?: string;
  status?: z.output<typeof runStatusSchema>;
  createdAtFrom?: string;
  createdAtBefore?: string;
  after?: WorkflowRunListPosition;
  signal?: AbortSignal;
}>;

export type WorkflowRunListPage = Readonly<{
  items: readonly WorkflowRunRecord[];
  nextCursor?: WorkflowRunListPosition;
}>;

const inputSchema = z
  .object({
    workspaceId: z.uuid(),
    limit: z.number().int().min(1).max(100),
    workflowId: z.uuid().optional(),
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

const rowSchema = z
  .object({ created_at_cursor: timestampCursorSchema })
  .loose();

export async function listWorkflowRunsInTransaction(
  transaction: WorkspaceTransaction,
  input: Omit<ListWorkflowRunsDatabaseInput, 'workspaceId' | 'signal'>,
): Promise<WorkflowRunListPage> {
  const result = await transaction.db.execute(sql`
    select
      id,
      workspace_id,
      workflow_id,
      workflow_version_id,
      status,
      trigger_type,
      created_at,
      updated_at,
      started_at,
      completed_at,
      deadline_at,
      cancel_requested_at,
      to_char(
        created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) as created_at_cursor
    from app.workflow_runs
    where workspace_id = ${transaction.workspaceId}
      and (${input.workflowId ?? null}::uuid is null
        or workflow_id = ${input.workflowId ?? null}::uuid)
      and (${input.status ?? null}::text is null
        or status = ${input.status ?? null}::text)
      and (${input.createdAtFrom ?? null}::timestamptz is null
        or created_at >= ${input.createdAtFrom ?? null}::timestamptz)
      and (${input.createdAtBefore ?? null}::timestamptz is null
        or created_at < ${input.createdAtBefore ?? null}::timestamptz)
      and (${input.after?.createdAt ?? null}::timestamptz is null
        or created_at < ${input.after?.createdAt ?? null}::timestamptz
        or (
          created_at = ${input.after?.createdAt ?? null}::timestamptz
          and id < ${input.after?.id ?? null}::uuid
        ))
    order by created_at desc, id desc
    limit ${input.limit + 1}
  `);
  const rows = result.rows.map((value) => {
    const { created_at_cursor: cursor, ...runRow } = rowSchema.parse(value);
    return { cursor, run: toWorkflowRunRecord(runRow) };
  });
  const hasMore = rows.length > input.limit;
  const visible = rows.slice(0, input.limit);
  const last = visible.at(-1);
  return Object.freeze({
    items: Object.freeze(visible.map(({ run }) => run)),
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

export function parseWorkflowRunListInput(
  input: ListWorkflowRunsDatabaseInput,
): z.output<typeof inputSchema> {
  return inputSchema.parse(input);
}
