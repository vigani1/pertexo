import { RUN_STATUS_VALUES } from '../commands/acceptance.repository.js';
import { RETAINED_RESOURCE_WORKSPACE_STATUSES } from '../../tenant-access/resources/policy.js';
import { sql } from 'drizzle-orm';
import { readFolderScope } from '../../tenant-access/resources/facts.queries.js';
import {
  bindResourcePredicate,
  workflowScopeSql,
} from '../../tenant-access/resources/scope.queries.js';
import type { Pool } from 'pg';
import type { UsageTrendPeriod, UsageTrendsResponse } from '@pertexo/contracts';
import { withTenantScopedReadClient } from '../../tenant-access/transactions.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import { ordinaryRunSql } from '../data-policy.js';

export type UsageTrendsInput = Readonly<{
  workspaceId: string;
  actorId: string;
  period: UsageTrendPeriod;
  includeWorkflowNames: boolean;
  signal?: AbortSignal;
}>;
type Counts = UsageTrendsResponse['byStatus'];
type Elapsed = UsageTrendsResponse['elapsed'];
interface DayRow {
  day: string;
  total: number;
  by_status: Counts;
  measured_runs: number;
  average_ms: number | null;
  slowest_ms: number | null;
}
interface RankedRow {
  workflow_id: string;
  workflow_name: string | null;
  runs: number;
  failures: number;
  runs_rank: string;
  failures_rank: string;
}
const timestamp = (expression: string) =>
  `to_char(${expression} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const elapsedSql =
  "case when run.status not in ('queued','running','waiting') then extract(epoch from (run.completed_at-run.started_at))*1000 end";
// Status names and SQL expressions come from shared definitions, never request text.
const countsSql = `jsonb_build_object(${RUN_STATUS_VALUES.map((status) => `'${status}',(count(*) filter(where run.status='${status}'))::integer`).join(',')})`;
const windowRowsSql = `select id,workflow_id,status,created_at,started_at,completed_at from app.workflow_runs
 where workspace_id=$1 and ${bindResourcePredicate(ordinaryRunSql().inlineParams(), [])} and created_at>=$2::timestamptz and created_at<$3::timestamptz`;
function emptyCounts(): Counts {
  return Object.fromEntries(
    RUN_STATUS_VALUES.map((status) => [status, 0]),
  ) as Counts;
}
function elapsed(row: DayRow): Elapsed {
  return {
    measuredRuns: row.measured_runs,
    averageMs: row.average_ms,
    slowestMs: row.slowest_ms,
  };
}

/** Two bounded workspace/date-range scans in one read-only snapshot; no run values. */
export function readUsageTrends(
  pool: Pool,
  input: UsageTrendsInput,
): Promise<UsageTrendsResponse> {
  return withTenantScopedReadClient(
    pool,
    { workspaceId: input.workspaceId, actorId: input.actorId },
    async (client) => {
      const access = await readFolderScope(
        client,
        input,
        undefined,
        RETAINED_RESOURCE_WORKSPACE_STATUSES,
      );
      const length = input.period === '30d' ? 30 : 90;
      const clock = await client.query<{
        as_of: string;
        from_at: string;
        coverage_from: string;
      }>(
        `with bounds as(select (date_trunc('day',transaction_timestamp() at time zone 'UTC')-make_interval(days=>$2::integer-1)) at time zone 'UTC' from_at)
 select ${timestamp('transaction_timestamp()')} as_of,${timestamp('bounds.from_at')} from_at,${timestamp('greatest(workspace.created_at,bounds.from_at)')} coverage_from
 from app.workspaces workspace cross join bounds where workspace.id=$1 and workspace.status in ('active','suspended','pending_deletion')`,
        [input.workspaceId, length],
      );
      const bounds = clock.rows[0];
      if (bounds === undefined) throw new WorkspaceAccessDeniedError();
      const parameters = [input.workspaceId, bounds.from_at, bounds.as_of];
      const dailyParameters: unknown[] = [
        ...parameters,
        JSON.stringify(emptyCounts()),
      ];
      const dailyWindow = `${windowRowsSql} and ${bindResourcePredicate(workflowScopeSql(access, sql`app.workflow_runs.workflow_id`), dailyParameters)}`;
      const daily = await client.query<DayRow>(
        `with window_runs as (${dailyWindow}), daily as (
 select (run.created_at at time zone 'UTC')::date utc_day,count(*)::integer total,${countsSql} by_status,
 count(${elapsedSql})::integer measured_runs,avg(${elapsedSql})::double precision average_ms,max(${elapsedSql})::double precision slowest_ms
 from window_runs run group by 1)
 select to_char(bucket.utc_day,'YYYY-MM-DD') as "day",coalesce(daily.total,0) total,coalesce(daily.by_status,$4::jsonb) by_status,
 coalesce(daily.measured_runs,0) measured_runs,daily.average_ms,daily.slowest_ms
 from generate_series($2::timestamptz at time zone 'UTC',($3::timestamptz at time zone 'UTC')::date,interval '1 day') as bucket(utc_day)
 left join daily on daily.utc_day=bucket.utc_day::date order by bucket.utc_day`,
        dailyParameters,
      );
      const rankingParameters: unknown[] = [
        ...parameters,
        input.includeWorkflowNames,
      ];
      const rankingWindow = `${windowRowsSql} and ${bindResourcePredicate(workflowScopeSql(access, sql`app.workflow_runs.workflow_id`), rankingParameters)}`;
      const rankings = await client.query<RankedRow>(
        `with window_runs as (${rankingWindow}), totals as (
 select workflow_id,count(*)::integer runs,(count(*) filter(where status in ('failed','timed_out','outcome_unknown')))::integer failures
 from window_runs group by workflow_id), ranked as (
 select *,row_number() over(order by runs desc,workflow_id) runs_rank,row_number() over(order by failures desc,workflow_id) failures_rank from totals)
 select ranked.*,case when $4::boolean then workflow.name else null end workflow_name from ranked
 left join app.workflows workflow on workflow.workspace_id=$1 and workflow.id=ranked.workflow_id
 where runs_rank<=10 or (failures_rank<=10 and failures>0) order by ranked.workflow_id`,
        rankingParameters,
      );
      const days = daily.rows.map((row) => ({
        day: row.day,
        total: row.total,
        byStatus: row.by_status,
        elapsed: elapsed(row),
      }));
      const byStatus = emptyCounts();
      let total = 0,
        measured = 0,
        sum = 0;
      let slowest: number | null = null;
      for (const row of daily.rows) {
        total += row.total;
        for (const status of RUN_STATUS_VALUES)
          byStatus[status] += row.by_status[status];
        measured += row.measured_runs;
        if (row.average_ms !== null) sum += row.average_ms * row.measured_runs;
        if (row.slowest_ms !== null)
          slowest = Math.max(slowest ?? 0, row.slowest_ms);
      }
      const project = (row: RankedRow) => ({
        workflowId: row.workflow_id,
        workflowName: row.workflow_name,
        runs: row.runs,
        failures: row.failures,
      });
      return {
        period: input.period,
        asOf: bounds.as_of,
        from: bounds.from_at,
        before: bounds.as_of,
        coverageFrom: bounds.coverage_from,
        total,
        byStatus,
        elapsed: {
          measuredRuns: measured,
          averageMs: measured === 0 ? null : sum / measured,
          slowestMs: slowest,
        },
        days,
        busiest: rankings.rows
          .filter((row) => Number(row.runs_rank) <= 10)
          .sort((a, b) => Number(a.runs_rank) - Number(b.runs_rank))
          .map(project),
        mostFailures: rankings.rows
          .filter((row) => row.failures > 0 && Number(row.failures_rank) <= 10)
          .sort((a, b) => Number(a.failures_rank) - Number(b.failures_rank))
          .map(project),
      };
    },
    {
      statementTimeoutMillis: 2000,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );
}
