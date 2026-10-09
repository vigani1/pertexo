import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/database-runtime.js';
import { databaseSchema } from '../schema.js';
import {
  parseWorkspaceId,
  withTenantScopedClient,
  withTenantScopedReadClient,
  type TenantTransactionScope,
} from '../tenant-access/workspace.js';
import {
  readWorkflowRunFailedSteps,
  type WorkflowRunFailedStep,
} from '../runs/queries/run-data.js';

export type WorkspaceInboxFailureKind =
  'failed' | 'timed_out' | 'outcome_unknown';

/** A failing workflow's thread as one reader sees it (ADR 055). */
export type WorkspaceInboxThreadRecord = Readonly<{
  workflowId: string;
  workflowName: string;
  kind: WorkspaceInboxFailureKind;
  occurrenceCount: number;
  firstOccurredAt: string;
  latestOccurredAt: string;
  latestRunId: string;
  latestFailedStep: WorkflowRunFailedStep | null;
  revision: string;
  unread: boolean;
}>;

/** Position after the last thread of a page, newest first. */
export type WorkspaceInboxCursor = Readonly<{
  latestOccurredAt: string;
  workflowId: string;
}>;

export type WorkspaceInboxThreadPage = Readonly<{
  items: readonly WorkspaceInboxThreadRecord[];
  next: WorkspaceInboxCursor | null;
  /** The newest revision visible now: the cut a later read-all may use. */
  revision: string;
}>;

export type WorkspaceInboxSummary = Readonly<{
  unreadCount: number;
  revision: string;
}>;

type ReaderScope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;

export interface WorkspaceInboxDatabase {
  listThreads(
    input: ReaderScope &
      Readonly<{
        filter: 'all' | 'unread';
        limit: number;
        after?: WorkspaceInboxCursor;
      }>,
  ): Promise<WorkspaceInboxThreadPage>;
  readSummary(input: ReaderScope): Promise<WorkspaceInboxSummary>;
  /** Marks one thread read up to the revision the reader saw; undefined when not visible. */
  markThreadRead(
    input: ReaderScope & Readonly<{ workflowId: string; revision: string }>,
  ): Promise<Readonly<{ unread: boolean; revision: string }> | undefined>;
  /** Marks every visible thread at or below the cut read. */
  markAllRead(
    input: ReaderScope & Readonly<{ revision: string }>,
  ): Promise<Readonly<{ marked: number }>>;
  close(): Promise<void>;
}

const STATEMENT_TIMEOUT_MILLIS = 2_000;
const timestampFormat = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const revisionSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/u);
const timestampSchema = z.iso.datetime({ precision: 6 });
const scopeSchema = z
  .object({
    workspaceId: z.uuid(),
    actorId: z.uuid(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();
const listInputSchema = scopeSchema
  .extend({
    filter: z.enum(['all', 'unread']),
    limit: z.number().int().min(1).max(100),
    after: z
      .object({ latestOccurredAt: timestampSchema, workflowId: z.uuid() })
      .strict()
      .optional(),
  })
  .strict();
const threadRowSchema = z
  .object({
    workflow_id: z.uuid(),
    workflow_name: z.string().min(1),
    latest_kind: z.enum(['failed', 'timed_out', 'outcome_unknown']),
    occurrence_count: z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    first_occurred_at: timestampSchema,
    latest_occurred_at: timestampSchema,
    latest_run_id: z.uuid(),
    revision: revisionSchema,
    unread: z.boolean(),
  })
  .strict();
const summaryRowSchema = z
  .object({
    unread_count: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    revision: revisionSchema,
  })
  .strict();

// Unread: no read, or a read older than the thread's revision. Threads, reads
// and workflows are all constrained by row security to this eligible reader.
const threadColumns = `
  thread.workflow_id,
  workflow.name as workflow_name,
  thread.latest_kind,
  thread.occurrence_count::text as occurrence_count,
  to_char(thread.first_occurred_at at time zone 'UTC',${timestampFormat}) as first_occurred_at,
  to_char(thread.latest_occurred_at at time zone 'UTC',${timestampFormat}) as latest_occurred_at,
  thread.latest_run_id,
  thread.revision::text as revision,
  (seen.read_revision is null or seen.read_revision<thread.revision) as unread`;
const threadSource = `
  from app.workspace_inbox_threads thread
  join app.workflows workflow
    on workflow.workspace_id=thread.workspace_id and workflow.id=thread.workflow_id
  left join app.workspace_inbox_reads seen
    on seen.workspace_id=thread.workspace_id and seen.workflow_id=thread.workflow_id
   and seen.user_id=$2`;

function readerScope(
  input: Readonly<{ workspaceId: string; actorId: string }>,
): TenantTransactionScope {
  return {
    workspaceId: parseWorkspaceId(input.workspaceId),
    actorId: input.actorId,
  };
}

async function visibleRevision(
  client: PoolClient,
  workspaceId: string,
): Promise<string> {
  const result = await client.query(
    `select coalesce(max(thread.revision),0)::text as revision
       from app.workspace_inbox_threads thread where thread.workspace_id=$1`,
    [workspaceId],
  );
  return revisionSchema.parse(
    z.object({ revision: z.string() }).parse(result.rows[0]).revision,
  );
}

/** ADR 055: an eligible reader's view of the workspace's failure threads. */
export function createWorkspaceInboxDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkspaceInboxDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  const options = (signal: AbortSignal | undefined) => ({
    ...(signal === undefined ? {} : { signal }),
    statementTimeoutMillis: STATEMENT_TIMEOUT_MILLIS,
  });
  const database: WorkspaceInboxDatabase = {
    listThreads: (input) => {
      const parsed = listInputSchema.parse(input);
      return withTenantScopedReadClient(
        pool,
        readerScope(parsed),
        async (client) => {
          const after = parsed.after;
          const result = await client.query(
            `select ${threadColumns} ${threadSource}
              where thread.workspace_id=$1
                and ($3::boolean is false
                  or seen.read_revision is null or seen.read_revision<thread.revision)
                and ($4::timestamptz is null
                  or (thread.latest_occurred_at,thread.workflow_id)<($4::timestamptz,$5::uuid))
              order by thread.latest_occurred_at desc,thread.workflow_id desc
              limit $6`,
            [
              parsed.workspaceId,
              parsed.actorId,
              parsed.filter === 'unread',
              after?.latestOccurredAt ?? null,
              after?.workflowId ?? null,
              parsed.limit + 1,
            ],
          );
          const rows = result.rows.map((value) => threadRowSchema.parse(value));
          const page = rows.slice(0, parsed.limit);
          const failedSteps = await readWorkflowRunFailedSteps(
            Object.freeze({
              db: drizzle(client, { schema: databaseSchema }),
              workspaceId: parseWorkspaceId(parsed.workspaceId),
            }),
            page.map((row) => row.latest_run_id),
          );
          const last = page.at(-1);
          return Object.freeze({
            items: Object.freeze(
              page.map((row) =>
                Object.freeze({
                  workflowId: row.workflow_id,
                  workflowName: row.workflow_name,
                  kind: row.latest_kind,
                  occurrenceCount: row.occurrence_count,
                  firstOccurredAt: row.first_occurred_at,
                  latestOccurredAt: row.latest_occurred_at,
                  latestRunId: row.latest_run_id,
                  latestFailedStep: failedSteps.get(row.latest_run_id) ?? null,
                  revision: row.revision,
                  unread: row.unread,
                }),
              ),
            ),
            next:
              rows.length > parsed.limit && last !== undefined
                ? Object.freeze({
                    latestOccurredAt: last.latest_occurred_at,
                    workflowId: last.workflow_id,
                  })
                : null,
            revision: await visibleRevision(client, parsed.workspaceId),
          });
        },
        options(parsed.signal),
      );
    },
    readSummary: (input) => {
      const parsed = scopeSchema.parse(input);
      return withTenantScopedReadClient(
        pool,
        readerScope(parsed),
        async (client) => {
          const result = await client.query(
            `select count(*) filter (
                     where seen.read_revision is null or seen.read_revision<thread.revision
                   ) as unread_count,
                   coalesce(max(thread.revision),0)::text as revision
               from app.workspace_inbox_threads thread
               left join app.workspace_inbox_reads seen
                 on seen.workspace_id=thread.workspace_id
                and seen.workflow_id=thread.workflow_id and seen.user_id=$2
              where thread.workspace_id=$1`,
            [parsed.workspaceId, parsed.actorId],
          );
          const row = summaryRowSchema.parse(result.rows[0]);
          return Object.freeze({
            unreadCount: row.unread_count,
            revision: row.revision,
          });
        },
        options(parsed.signal),
      );
    },
    markThreadRead: (input) => {
      const parsed = scopeSchema
        .extend({ workflowId: z.uuid(), revision: revisionSchema })
        .strict()
        .parse(input);
      return withTenantScopedClient(
        pool,
        readerScope(parsed),
        async (client) => {
          // Never above the thread's revision: a failure the reader has not
          // seen keeps the thread unread.
          await client.query(
            `insert into app.workspace_inbox_reads as seen
               (workspace_id,user_id,workflow_id,read_revision)
             select thread.workspace_id,$2,thread.workflow_id,
                    least($4::bigint,thread.revision)
               from app.workspace_inbox_threads thread
              where thread.workspace_id=$1 and thread.workflow_id=$3
                and $4::bigint>0
             on conflict (workspace_id,user_id,workflow_id) do update
               set read_revision=excluded.read_revision,read_at=clock_timestamp()
               where seen.read_revision<excluded.read_revision`,
            [
              parsed.workspaceId,
              parsed.actorId,
              parsed.workflowId,
              parsed.revision,
            ],
          );
          const current = await client.query(
            `select thread.revision::text as revision,
                    (seen.read_revision is null or seen.read_revision<thread.revision) as unread
               from app.workspace_inbox_threads thread
               left join app.workspace_inbox_reads seen
                 on seen.workspace_id=thread.workspace_id
                and seen.workflow_id=thread.workflow_id and seen.user_id=$2
              where thread.workspace_id=$1 and thread.workflow_id=$3`,
            [parsed.workspaceId, parsed.actorId, parsed.workflowId],
          );
          const row = current.rows[0] as unknown;
          if (row === undefined) return undefined;
          const state = z
            .object({ revision: revisionSchema, unread: z.boolean() })
            .strict()
            .parse(row);
          return Object.freeze({
            unread: state.unread,
            revision: state.revision,
          });
        },
        options(parsed.signal),
      );
    },
    markAllRead: (input) => {
      const parsed = scopeSchema
        .extend({ revision: revisionSchema })
        .strict()
        .parse(input);
      return withTenantScopedClient(
        pool,
        readerScope(parsed),
        async (client) => {
          const result = await client.query(
            `insert into app.workspace_inbox_reads as seen
               (workspace_id,user_id,workflow_id,read_revision)
             select thread.workspace_id,$2,thread.workflow_id,thread.revision
               from app.workspace_inbox_threads thread
              where thread.workspace_id=$1 and thread.revision<=$3::bigint
             on conflict (workspace_id,user_id,workflow_id) do update
               set read_revision=excluded.read_revision,read_at=clock_timestamp()
               where seen.read_revision<excluded.read_revision`,
            [parsed.workspaceId, parsed.actorId, parsed.revision],
          );
          return Object.freeze({ marked: result.rowCount ?? 0 });
        },
        options(parsed.signal),
      );
    },
    close: () => lease.close(),
  };
  return Object.freeze(database);
}
