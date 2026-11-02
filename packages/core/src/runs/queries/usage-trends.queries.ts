import { emptyRunCounts } from './counts.js';
import {
  readTrendBounds,
  readTrendDays,
  readTrendRankings,
  type TrendDay,
  type TrendRanking,
} from './trends/records.queries.js';
import { RUN_STATUS_VALUES } from '../commands/acceptance/vocabulary.js';
import { UNPURGED_WORKSPACE_STATUSES } from '@pertexo/workflow-model';

import { readFolderScope } from '../../shared/facts.queries.js';

import type { Pool } from 'pg';
import type { UsageTrendPeriod, UsageTrendsResponse } from '@pertexo/contracts';
import { withTenantScopedReadClient } from '@pertexo/database/primitives';
import { WorkspaceAccessDeniedError } from '../../shared/errors.js';

export type UsageTrendsInput = Readonly<{
  workspaceId: string;
  actorId: string;
  period: UsageTrendPeriod;
  includeWorkflowNames: boolean;
  signal?: AbortSignal;
}>;
type Elapsed = UsageTrendsResponse['elapsed'];
function elapsed(row: TrendDay): Elapsed {
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
        UNPURGED_WORKSPACE_STATUSES,
      );
      const length = input.period === '30d' ? 30 : 90;
      const [bounds] = await readTrendBounds(client, {
        workspaceId: input.workspaceId,
        days: length,
      });
      if (bounds === undefined) throw new WorkspaceAccessDeniedError();
      const query = { workspaceId: input.workspaceId, bounds, scope: access };
      const daily = await readTrendDays(client, query);
      const rankings = await readTrendRankings(client, {
        ...query,
        includeWorkflowNames: input.includeWorkflowNames,
      });
      const days = daily.map((row) => ({
        day: row.day,
        total: row.total,
        byStatus: row.by_status,
        elapsed: elapsed(row),
      }));
      const byStatus = emptyRunCounts();
      let total = 0,
        measured = 0,
        sum = 0;
      let slowest: number | null = null;
      for (const row of daily) {
        total += row.total;
        for (const status of RUN_STATUS_VALUES)
          byStatus[status] += row.by_status[status];
        measured += row.measured_runs;
        if (row.average_ms !== null) sum += row.average_ms * row.measured_runs;
        if (row.slowest_ms !== null)
          slowest = Math.max(slowest ?? 0, row.slowest_ms);
      }
      const project = (row: TrendRanking) => ({
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
        busiest: rankings
          .filter((row) => row.runs_rank <= 10)
          .sort((a, b) => a.runs_rank - b.runs_rank)
          .map(project),
        mostFailures: rankings
          .filter((row) => row.failures > 0 && row.failures_rank <= 10)
          .sort((a, b) => a.failures_rank - b.failures_rank)
          .map(project),
      };
    },
    {
      statementTimeoutMillis: 2000,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );
}
