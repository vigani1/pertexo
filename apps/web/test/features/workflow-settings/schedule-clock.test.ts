import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import { scheduleNextRunsQueryOptions } from '@/features/workflow-settings/data/workflow-settings.queries';
it.each([-1, 1])(
  'clamps schedule refresh around its floor with clock offset %i',
  (offset) => {
    const first = Date.parse('2030-01-01T12:00:00Z');
    const options = scheduleNextRunsQueryOptions({
      apiClient: createApiClient({
        fetch: globalThis.fetch,
        readCsrfToken: () => undefined,
      }),
      userId: 'user',
      workspaceId: 'workspace',
      workflowId: 'workflow',
      triggerId: 'trigger',
      now: () => first + 1000 - 30000 + offset,
    });
    const client = new QueryClient();
    client.setQueryData(options.queryKey, {
      observedAt: new Date(first).toISOString(),
      items: [{ scheduledAt: new Date(first).toISOString() }],
    });
    const query = new QueryObserver(client, options).getCurrentQuery();
    const interval = options.refetchInterval;
    if (typeof interval !== 'function')
      throw new Error('Expected a schedule refresh callback');
    expect(interval(query)).toBe(offset < 0 ? 30001 : 30000);
    client.clear();
  },
);
