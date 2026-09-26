import type {
  WorkflowRunListResponse,
  WorkflowRunStatisticsResponse,
  WorkflowRunStatisticsWindow,
} from '@pertexo/contracts/schemas/workflow-runs';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { findWorkflowVersion } from '@/features/workflow-versions/public';
import type { RunHistoryFilters } from './model/run-search';
import type { RunStatus } from './model/run-status';
import {
  getRunsSince,
  getWorkflowRun,
  getWorkflowRunStatistics,
  getWorkflowRunsPage,
} from './workflow-runs.api';

export const workflowRunKeys = {
  scope: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'runs'] as const,
  history: (userId: string, workspaceId: string, filters: RunHistoryFilters) =>
    [
      ...workflowRunKeys.scope(userId, workspaceId),
      'history',
      filters,
    ] as const,
  detail: (userId: string, workspaceId: string, runId: string) =>
    [...workflowRunKeys.scope(userId, workspaceId), 'detail', runId] as const,
  statistics: (
    userId: string,
    workspaceId: string,
    window: WorkflowRunStatisticsWindow,
    breakdown: 'none' | 'workflow',
  ) =>
    [
      ...workflowRunKeys.scope(userId, workspaceId),
      'statistics',
      window,
      breakdown,
    ] as const,
  attention: (userId: string, workspaceId: string) =>
    [...workflowRunKeys.scope(userId, workspaceId), 'attention-24h'] as const,
  loom: (userId: string, workspaceId: string, windowMs: number) =>
    [...workflowRunKeys.scope(userId, workspaceId), 'loom', windowMs] as const,
  anyRun: (userId: string, workspaceId: string) =>
    [...workflowRunKeys.scope(userId, workspaceId), 'any'] as const,
  latestOf: (
    userId: string,
    workspaceId: string,
    workflowId: string,
    limit: number,
  ) =>
    [
      ...workflowRunKeys.scope(userId, workspaceId),
      'latest-of',
      workflowId,
      limit,
    ] as const,
};

/** One bounded page per status for lists; counts come from statistics. */
const STATUS_PAGE_SIZE = 100;
const STATISTICS_REFRESH_MS = 15_000;
const DAY_MS = 86_400_000;
const LOOM_RUN_CAP = 300;
const ACTIVE_RUN_STATUSES = ['running', 'waiting', 'queued'] as const;

/** Exact counts from one server snapshot (ADR 044). */
export type RunStatistics = WorkflowRunStatisticsResponse;

type StatusSample = Readonly<{
  count: number;
  /** More runs exist than the page could hold. */
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

function sample(page: WorkflowRunListResponse): StatusSample {
  return {
    count: page.items.length,
    more: page.nextCursor !== null,
    runs: page.items,
  };
}

function statusPages(
  apiClient: ApiClient,
  workspaceId: string,
  statuses: readonly RunStatus[],
  filters: RunHistoryFilters,
  signal: AbortSignal,
): Promise<StatusSample[]> {
  return Promise.all(
    statuses.map(async (status) =>
      sample(
        await getWorkflowRunsPage(
          apiClient,
          workspaceId,
          { ...filters, status },
          { limit: STATUS_PAGE_SIZE, signal },
        ),
      ),
    ),
  );
}

export function workflowRunsInfiniteQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  filters: RunHistoryFilters,
) {
  return infiniteQueryOptions({
    queryKey: workflowRunKeys.history(userId, workspaceId, filters),
    queryFn: ({ pageParam, signal }) =>
      getWorkflowRunsPage(apiClient, workspaceId, filters, {
        ...(pageParam === null ? {} : { after: pageParam }),
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
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
    staleTime: STATISTICS_REFRESH_MS,
    refetchInterval: STATISTICS_REFRESH_MS,
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
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

/** Failed, timed-out and unknown-outcome runs from the last 24 hours. */
export function attentionRunsQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: workflowRunKeys.attention(userId, workspaceId),
    queryFn: async ({ signal }): Promise<AttentionRuns> => {
      const asOf = Date.now();
      const createdAtFrom = new Date(asOf - DAY_MS).toISOString();
      const [failed, timedOut, outcomeUnknown] = await statusPages(
        apiClient,
        workspaceId,
        ['failed', 'timed_out', 'outcome_unknown'],
        { createdAtFrom },
        signal,
      );
      if (
        failed === undefined ||
        timedOut === undefined ||
        outcomeUnknown === undefined
      )
        throw new Error('Runs needing attention are incomplete.');
      return { asOf, failed, timedOut, outcomeUnknown };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
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
        statusPages(
          apiClient,
          workspaceId,
          ACTIVE_RUN_STATUSES,
          { createdAtBefore: windowStart },
          signal,
        ),
      ]);
      return {
        asOf,
        windowMs,
        runs: [...window.runs, ...earlier.flatMap(({ runs }) => runs)],
        capped: window.capped,
      };
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

/**
 * One workflow's latest runs, newest first: its strip in the Workflows list,
 * whatever else the workspace has been running.
 */
export function workflowLatestRunsQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
  limit: number,
) {
  return queryOptions({
    queryKey: workflowRunKeys.latestOf(userId, workspaceId, workflowId, limit),
    queryFn: async ({ signal }) =>
      (
        await getWorkflowRunsPage(
          apiClient,
          workspaceId,
          { workflowId },
          { limit, signal },
        )
      ).items,
    staleTime: 30_000,
  });
}

/** Whether the workspace has ever run anything (for the first-run guide). */
export function anyRunQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: workflowRunKeys.anyRun(userId, workspaceId),
    queryFn: async ({ signal }) => {
      const page = await getWorkflowRunsPage(
        apiClient,
        workspaceId,
        {},
        { limit: 1, signal },
      );
      return page.items.length > 0;
    },
    staleTime: 60_000,
  });
}

export function workflowRunQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  runId: string,
) {
  return queryOptions({
    queryKey: workflowRunKeys.detail(userId, workspaceId, runId),
    queryFn: ({ signal }) =>
      getWorkflowRun(apiClient, workspaceId, runId, signal),
    staleTime: 0,
  });
}

export function workflowRunVersionQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
  versionId: string,
) {
  return queryOptions({
    queryKey: [
      'identity',
      userId,
      'workspace',
      workspaceId,
      'workflow',
      workflowId,
      'version',
      versionId,
    ] as const,
    queryFn: ({ signal }) =>
      findWorkflowVersion(
        apiClient,
        workspaceId,
        workflowId,
        versionId,
        signal,
      ),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
