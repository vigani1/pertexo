import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
  type SQLWrapper,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { workspaces } from '../../../schema/foundation.js';
import { workflows } from '../../../schema/authoring/workflows.js';
import { workflowRuns } from '../../../schema/runs/execution.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { FolderScope } from '../../../tenant-access/resources/contract.js';
import { workflowScopeSql } from '../../../tenant-access/resources/scope.queries.js';
import { UNPURGED_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import { ordinaryRunSql } from '../../data-policy.js';
import { emptyRunCounts, type RunStatusCounts } from '../counts.js';

const timestamp = (expression: SQLWrapper) =>
  sql<string>`to_char(${expression} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export function readTrendBounds(
  client: PoolClient,
  { workspaceId, days }: Readonly<{ workspaceId: string; days: number }>,
) {
  const from = sql`(date_trunc('day',transaction_timestamp() at time zone 'UTC')-make_interval(days=>${days}::integer-1)) at time zone 'UTC'`;
  return drizzle(client)
    .select({
      as_of: timestamp(sql`transaction_timestamp()`),
      from_at: timestamp(from),
      coverage_from: timestamp(sql`greatest(${workspaces.createdAt},${from})`),
    })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, workspaceId),
        inArray(workspaces.status, UNPURGED_WORKSPACE_STATUSES),
      ),
    )
    .catch(rethrowQueryFailure);
}
type TrendBounds = Awaited<ReturnType<typeof readTrendBounds>>[number];
type TrendWindow = Readonly<{
  workspaceId: string;
  bounds: TrendBounds;
  scope: FolderScope;
}>;
function windowRuns(
  client: PoolClient,
  { workspaceId, bounds, scope }: TrendWindow,
) {
  const db = drizzle(client);
  return db.$with('window_runs').as(
    db
      .select({
        id: workflowRuns.id,
        workflow_id: workflowRuns.workflowId,
        status: workflowRuns.status,
        created_at: workflowRuns.createdAt,
        started_at: workflowRuns.startedAt,
        completed_at: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.workspaceId, workspaceId),
          ordinaryRunSql('workflow_runs'),
          gte(workflowRuns.createdAt, sql`${bounds.from_at}::timestamptz`),
          lt(workflowRuns.createdAt, sql`${bounds.as_of}::timestamptz`),
          workflowScopeSql(scope, sql`${workflowRuns.workflowId}`),
        ),
      ),
  );
}
function statusCounts(status: SQLWrapper) {
  const fields = Object.keys(emptyRunCounts()).flatMap((value) => [
    sql`${value}::text`,
    sql`count(*) filter(where ${status}=${value})::integer`,
  ]);
  return sql<RunStatusCounts>`jsonb_build_object(${sql.join(fields, sql`,`)})`;
}
export function readTrendDays(client: PoolClient, input: TrendWindow) {
  const db = drizzle(client),
    window = windowRuns(client, input);
  const elapsed = sql<
    number | null
  >`case when ${window.status} not in ('queued','running','waiting') then extract(epoch from (${window.completed_at}-${window.started_at}))*1000 end`;
  const utcDay = sql<string>`(${window.created_at} at time zone 'UTC')::date`;
  const daily = db.$with('daily').as(
    db
      .select({
        utc_day: utcDay.as('trend_day'),
        total: sql<number>`count(*)::integer`.as('total'),
        by_status: statusCounts(window.status).as('by_status'),
        measured_runs: sql<number>`count(${elapsed})::integer`.as(
          'measured_runs',
        ),
        average_ms: sql<number | null>`avg(${elapsed})::double precision`.as(
          'average_ms',
        ),
        slowest_ms: sql<number | null>`max(${elapsed})::double precision`.as(
          'slowest_ms',
        ),
      })
      .from(window)
      .groupBy(utcDay),
  );
  const buckets = sql`generate_series(${input.bounds.from_at}::timestamptz at time zone 'UTC',(${input.bounds.as_of}::timestamptz at time zone 'UTC')::date,interval '1 day') as bucket(utc_day)`;
  return db
    .with(window, daily)
    .select({
      day: sql<string>`to_char(bucket.utc_day,'YYYY-MM-DD')`,
      total: sql<number>`coalesce(${daily.total},0)`,
      by_status: sql<RunStatusCounts>`coalesce(${daily.by_status},${JSON.stringify(emptyRunCounts())}::jsonb)`,
      measured_runs: sql<number>`coalesce(${daily.measured_runs},0)`,
      average_ms: daily.average_ms,
      slowest_ms: daily.slowest_ms,
    })
    .from(buckets)
    .leftJoin(daily, sql`${daily.utc_day}=bucket.utc_day::date`)
    .orderBy(sql`bucket.utc_day`)
    .catch(rethrowQueryFailure);
}
export type TrendDay = Awaited<ReturnType<typeof readTrendDays>>[number];
export function readTrendRankings(
  client: PoolClient,
  input: TrendWindow & Readonly<{ includeWorkflowNames: boolean }>,
) {
  const db = drizzle(client),
    window = windowRuns(client, input);
  const totals = db.$with('totals').as(
    db
      .select({
        workflow_id: window.workflow_id,
        runs: sql<number>`count(*)::integer`.as('runs'),
        failures:
          sql<number>`count(*) filter(where ${window.status} in ('failed','timed_out','outcome_unknown'))::integer`.as(
            'failures',
          ),
      })
      .from(window)
      .groupBy(window.workflow_id),
  );
  const ranked = db.$with('ranked').as(
    db
      .select({
        workflow_id: totals.workflow_id,
        runs: totals.runs,
        failures: totals.failures,
        runs_rank:
          sql<number>`row_number() over(order by ${totals.runs} desc,${totals.workflow_id})`
            .mapWith(Number)
            .as('runs_rank'),
        failures_rank:
          sql<number>`row_number() over(order by ${totals.failures} desc,${totals.workflow_id})`
            .mapWith(Number)
            .as('failures_rank'),
      })
      .from(totals),
  );
  return db
    .with(window, totals, ranked)
    .select({
      workflow_id: ranked.workflow_id,
      runs: ranked.runs,
      failures: ranked.failures,
      runs_rank: ranked.runs_rank,
      failures_rank: ranked.failures_rank,
      workflow_name: input.includeWorkflowNames
        ? workflows.name
        : sql<string | null>`null`,
    })
    .from(ranked)
    .leftJoin(
      workflows,
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, ranked.workflow_id),
      ),
    )
    .where(
      or(
        lte(ranked.runs_rank, 10),
        and(lte(ranked.failures_rank, 10), gt(ranked.failures, 0)),
      ),
    )
    .orderBy(asc(ranked.workflow_id))
    .catch(rethrowQueryFailure);
}
export type TrendRanking = Awaited<
  ReturnType<typeof readTrendRankings>
>[number];
