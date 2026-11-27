import { QUERY_FRESHNESS, QUERY_POLLING } from '@/lib/api/query-timings';
import type {
  WorkflowRunListResponse,
  WorkflowRunStatisticsResponse,
  WorkflowRunStatisticsWindow,
} from '@pertexo/contracts';
import { queryOptions, skipToken } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import type { RunHistoryFilters } from '../model/list/run-search';
import type { RunStatus } from '../model/presentation/run-status';
import {
  getRunsSince,
  getWorkflowRunStatistics,
  getWorkflowRunsPage,
} from './workflow-runs.api';
import { workflowRunKeys } from './query-cache';

/** One bounded page per status for lists; counts come from statistics. */
const STATUS_PAGE_SIZE = 100;

/** Home's attention list reads the runs that went wrong in this many hours. */
export const ATTENTION_WINDOW_HOURS = 24;

const LOOM_RUN_CAP = 300;

const ACTIVE_RUN_STATUSES = ['running', 'waiting', 'queued'] as const;

/** Exact counts from one server snapshot (ADR 044). */
export type RunStatistics = WorkflowRunStatisticsResponse;

type StatusSample = Readonly<{
  /** The list omits some runs the statistics snapshot counted. */
  more: boolean;
  runs: WorkflowRunListResponse['items'];
}>;

export type AttentionRuns = Readonly<{
  asOf: number;
  failed: StatusSample;
  timedOut: StatusSample;
  outcomeUnknown: StatusSample;
}>;

export type LoomWindowRuns = Readonly<{
  asOf: number;
  windowMs: number;
  runs: WorkflowRunListResponse['items'];
  /** More runs were created in the window than the Loom draws. */
  capped: boolean;
}>;

function statusPages({
  apiClient,
  workspaceId,
  statuses,
  filters,
  signal,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  statuses: readonly RunStatus[];
  filters: RunHistoryFilters;
  signal: AbortSignal;
}>): Promise<WorkflowRunListResponse['items'][]> {
  return Promise.all(
    statuses.map(async (status) => {
      const page = await getWorkflowRunsPage(
        apiClient,
        workspaceId,
        { ...filters, status },
        { limit: STATUS_PAGE_SIZE, signal },
      );
      return page.items;
    }),
  );
}

/**
 * The live header counts: what is queued, running and waiting now, and every
 * status over the last 24 hours. One request that the spine and the Home and
 * Runs headers share, so they never disagree.
 */
export function runStatisticsQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: workflowRunKeys.statistics(userId, workspaceId, '24h', 'none'),
    queryFn: ({ signal }) =>
      getWorkflowRunStatistics(
        apiClient,
        workspaceId,
        { window: '24h' },
        signal,
      ),
    staleTime: QUERY_FRESHNESS.recent,
    refetchInterval: QUERY_POLLING.recent,
  });
}

/** Runs running now, for the spine badge, from the shared read. */
export function liveRunCountQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return queryOptions({
    ...runStatisticsQueryOptions(apiClient, userId, workspaceId),
    // The spine counts only what is running now, like its Core.
    select: (statistics: RunStatistics) => statistics.current.running,
  });
}

/** The Loom's true totals for a window, with one row per busy workflow. */
export function loomStatisticsQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  window: WorkflowRunStatisticsWindow,
) {
  return queryOptions({
    queryKey: workflowRunKeys.statistics(
      userId,
      workspaceId,
      window,
      'workflow',
    ),
    queryFn: ({ signal }) =>
      getWorkflowRunStatistics(
        apiClient,
        workspaceId,
        { window, breakdown: 'workflow' },
        signal,
      ),
    staleTime: QUERY_FRESHNESS.recent,
    refetchInterval: QUERY_POLLING.status,
  });
}

/** The failed, timed-out and unknown runs that explain the header's counts. */
export function attentionRunsQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  statistics: RunStatistics | undefined,
) {
  const window = statistics?.window;
  return queryOptions({
    queryKey: [
      ...workflowRunKeys.attention(userId, workspaceId),
      window,
    ] as const,
    queryFn:
      window === undefined
        ? skipToken
        : async ({ signal }): Promise<AttentionRuns> => {
            const { createdAtFrom, createdAtBefore, byStatus } = window;
            const [failed, timedOut, outcomeUnknown] = await statusPages({
              apiClient,
              workspaceId,
              statuses: ['failed', 'timed_out', 'outcome_unknown'],
              filters: { createdAtFrom, createdAtBefore },
              signal,
            });
            if (
              failed === undefined ||
              timedOut === undefined ||
              outcomeUnknown === undefined
            )
              throw new Error('Runs needing attention are incomplete.');
            return {
              asOf: Date.parse(createdAtBefore),
              failed: withinCount(failed, byStatus.failed),
              timedOut: withinCount(timedOut, byStatus.timed_out),
              outcomeUnknown: withinCount(
                outcomeUnknown,
                byStatus.outcome_unknown,
              ),
            };
          },
    staleTime: QUERY_FRESHNESS.standard,
  });
}

// The lists can observe status changes after the statistics snapshot.
function withinCount(
  runs: WorkflowRunListResponse['items'],
  count: number,
): StatusSample {
  return { runs: runs.slice(0, count), more: runs.length < count };
}

/**
 * The runs the Loom draws: every run created in a rolling window, capped at
 * 300, plus runs still active from before it so their threads reach the
 * Core. Totals come from `loomStatisticsQueryOptions`, never from this list.
 */
export function runLoomQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  windowMs: number,
) {
  return queryOptions({
    queryKey: workflowRunKeys.loom(userId, workspaceId, windowMs),
    queryFn: async ({ signal }): Promise<LoomWindowRuns> => {
      const asOf = Date.now();
      const windowStart = new Date(asOf - windowMs).toISOString();
      const [window, earlier] = await Promise.all([
        getRunsSince(apiClient, workspaceId, windowStart, {
          cap: LOOM_RUN_CAP,
          signal,
        }),
        statusPages({
          apiClient,
          workspaceId,
          statuses: ACTIVE_RUN_STATUSES,
          filters: { createdAtBefore: windowStart },
          signal,
        }),
      ]);
      return {
        asOf,
        windowMs,
        runs: [...window.runs, ...earlier.flat()],
        capped: window.capped,
      };
    },
    staleTime: QUERY_FRESHNESS.recent,
    refetchInterval: QUERY_POLLING.status,
  });
}
