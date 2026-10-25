import type { AccessibleWorkspace } from '@pertexo/contracts';
import { HttpResponse, http } from 'msw';
import {
  fixtureIds,
  fixtureRun,
  fixtureTimestamp,
  fixtureWorkflow,
  minutesAgo,
  statisticsHandler,
} from '../../../support/fixtures/run';
export const workspaceId = fixtureIds.workspace;

export const workflowId = fixtureIds.workflow;

export const recentRunId = fixtureIds.firstRun;

export const failedRunId = fixtureIds.secondRun;

export const connectionId = '99999999-9999-4999-8999-999999999999';

export const timestamp = fixtureTimestamp;

export function workflow(overrides: Record<string, unknown> = {}) {
  return fixtureWorkflow({ name: 'Daily intake', ...overrides });
}

export function run(id: string, status: 'succeeded' | 'failed') {
  const createdAt = minutesAgo(status === 'failed' ? 30 : 12);
  return fixtureRun(id, status, {
    workflowName: 'Daily intake',
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: minutesAgo(10),
  });
}

export type RunReads = Readonly<{
  failed?: () => Response | undefined;
  problems?: readonly ReturnType<typeof run>[];
  any?: readonly ReturnType<typeof run>[];
  statistics?: Parameters<typeof statisticsHandler>[0];
  statisticsSeen?: URLSearchParams[];
}>;

export function runHandlers(
  reads: RunReads = {},
  seen: URLSearchParams[] = [],
) {
  const runs = http.get(
    `http://pertexo.test/v1/workspaces/${workspaceId}/runs`,
    ({ request }) => {
      const query = new URL(request.url).searchParams;
      seen.push(query);
      const status = query.get('status');
      if (status === 'failed') {
        const override = reads.failed?.();
        if (override !== undefined) return override;
        return HttpResponse.json({
          items: reads.problems ?? [run(failedRunId, 'failed')],
          nextCursor: null,
        });
      }
      if (status !== null)
        return HttpResponse.json({ items: [], nextCursor: null });
      if (query.get('limit') === '1')
        return HttpResponse.json({
          items: reads.any ?? [run(recentRunId, 'succeeded')],
          nextCursor: null,
        });
      return HttpResponse.json({
        items: [run(recentRunId, 'succeeded'), run(failedRunId, 'failed')],
        nextCursor: null,
      });
    },
  );
  return [runs, statisticsHandler(reads.statistics, reads.statisticsSeen)];
}

export function workflowHandlers(
  items: readonly unknown[] = [workflow()],
  seen: string[] = [],
) {
  return http.get(
    `http://pertexo.test/v1/workspaces/${workspaceId}/workflows`,
    ({ request }) => {
      seen.push(new URL(request.url).search);
      return HttpResponse.json({ items, nextCursor: null });
    },
  );
}

export const readerCapabilities: AccessibleWorkspace['capabilities'] = [
  'workspace:read',
  'workflow:read',
  'run:read',
];
