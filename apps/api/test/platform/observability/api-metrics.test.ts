import type { Meter } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import {
  API_METRIC_NAME,
  registerApiMetrics,
} from '../../../src/platform/observability/api-metrics.js';

describe('API metrics', () => {
  it('records only bounded route and problem classifications', () => {
    type Hook = (...args: unknown[]) => unknown;
    const hooks = new Map<string, Hook>();
    const requestCount = vi.fn();
    const eligibleCount = vi.fn();
    const record = vi.fn();
    const createCounter = vi.fn((name: string) => ({
      add:
        name === API_METRIC_NAME.eligibleRequests
          ? eligibleCount
          : requestCount,
    }));
    const createHistogram = vi.fn(() => ({ record }));
    const meter = {
      createCounter,
      createHistogram,
    } as unknown as Meter;
    const server = {
      addHook: vi.fn((name: string, hook: Hook) => {
        hooks.set(name, hook);
      }),
    };

    registerApiMetrics(server as never, meter);

    expect(createCounter).toHaveBeenCalledWith(
      API_METRIC_NAME.requests,
      expect.any(Object),
    );
    expect(createCounter).toHaveBeenCalledWith(
      API_METRIC_NAME.eligibleRequests,
      expect.any(Object),
    );
    expect(createHistogram).toHaveBeenCalledWith(
      API_METRIC_NAME.requestDuration,
      expect.any(Object),
    );
    expect([...hooks.keys()]).toEqual(['onRequest', 'onSend', 'onResponse']);

    const request = {
      method: 'GET',
      routeOptions: { url: '/v1/workspaces/:workspaceId/runs/:runId' },
      id: 'unbounded-request-id',
    };
    const reply = { statusCode: 503 };
    hooks.get('onRequest')?.(request, reply, vi.fn());
    hooks.get('onSend')?.(
      request,
      reply,
      JSON.stringify({ code: 'provider.unavailable' }),
      vi.fn(),
    );
    hooks.get('onResponse')?.(request, reply, vi.fn());

    expect(requestCount).toHaveBeenCalledWith(1, {
      method: 'GET',
      problem_code: 'provider.unavailable',
      route: '/v1/workspaces/:workspaceId/runs/:runId',
      status_class: '5xx',
    });
    expect(eligibleCount).toHaveBeenCalledWith(1, {
      outcome: 'capacity_shed',
      route: '/v1/workspaces/:workspaceId/runs/:runId',
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(requestCount.mock.calls)).not.toContain(
      'unbounded-request-id',
    );
  });
});
