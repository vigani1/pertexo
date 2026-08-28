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
        name === API_METRIC_NAME.availabilityRequests
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
      API_METRIC_NAME.availabilityRequests,
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
      outcome: 'eligible_failure',
      route: '/v1/workspaces/:workspaceId/runs/:runId',
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(requestCount.mock.calls)).not.toContain(
      'unbounded-request-id',
    );

    const shedRequest = {
      method: 'POST',
      routeOptions: {
        url: '/v1/workspaces/:workspaceId/workflows/:workflowId/runs',
      },
    };
    const shedReply = { statusCode: 429 };
    hooks.get('onRequest')?.(shedRequest, shedReply, vi.fn());
    hooks.get('onSend')?.(
      shedRequest,
      shedReply,
      JSON.stringify({ code: 'workspace.quota_exceeded' }),
      vi.fn(),
    );
    hooks.get('onResponse')?.(shedRequest, shedReply, vi.fn());
    expect(eligibleCount).toHaveBeenLastCalledWith(1, {
      outcome: 'excluded_tenant_quota',
      route: '/v1/workspaces/:workspaceId/workflows/:workflowId/runs',
    });

    const invalidRequest = {
      method: 'POST',
      routeOptions: { url: '/v1/workspaces' },
    };
    const invalidReply = { statusCode: 400 };
    hooks.get('onSend')?.(
      invalidRequest,
      invalidReply,
      JSON.stringify({ code: 'request.invalid' }),
      vi.fn(),
    );
    hooks.get('onResponse')?.(invalidRequest, invalidReply, vi.fn());
    expect(eligibleCount).toHaveBeenLastCalledWith(1, {
      outcome: 'excluded_client',
      route: '/v1/workspaces',
    });

    const conflictRequest = {
      method: 'PUT',
      routeOptions: {
        url: '/v1/workspaces/:workspaceId/workflows/:workflowId',
      },
    };
    const conflictReply = { statusCode: 412 };
    hooks.get('onSend')?.(
      conflictRequest,
      conflictReply,
      JSON.stringify({ code: 'workflow.revision_conflict' }),
      vi.fn(),
    );
    hooks.get('onResponse')?.(conflictRequest, conflictReply, vi.fn());
    expect(eligibleCount).toHaveBeenLastCalledWith(1, {
      outcome: 'eligible_success',
      route: '/v1/workspaces/:workspaceId/workflows/:workflowId',
    });

    const correctnessFailureRequest = {
      method: 'POST',
      routeOptions: {
        url: '/v1/workspaces/:workspaceId/workflows/:workflowId',
      },
    };
    const correctnessFailureReply = { statusCode: 409 };
    hooks.get('onSend')?.(
      correctnessFailureRequest,
      correctnessFailureReply,
      JSON.stringify({ code: 'workflow.activation_failed' }),
      vi.fn(),
    );
    hooks.get('onResponse')?.(
      correctnessFailureRequest,
      correctnessFailureReply,
      vi.fn(),
    );
    expect(eligibleCount).toHaveBeenLastCalledWith(1, {
      outcome: 'eligible_failure',
      route: '/v1/workspaces/:workspaceId/workflows/:workflowId',
    });

    const backpressureRequest = {
      method: 'POST',
      routeOptions: { url: '/v1/node-tests' },
    };
    const backpressureReply = { statusCode: 429 };
    hooks.get('onSend')?.(
      backpressureRequest,
      backpressureReply,
      JSON.stringify({ code: 'provider.rate_limited' }),
      vi.fn(),
    );
    hooks.get('onResponse')?.(backpressureRequest, backpressureReply, vi.fn());
    expect(eligibleCount).toHaveBeenLastCalledWith(1, {
      outcome: 'eligible_failure',
      route: '/v1/node-tests',
    });

    const unmatchedRequest = { method: 'GET', routeOptions: {} };
    const unmatchedReply = { statusCode: 404 };
    const eligibilityCalls = eligibleCount.mock.calls.length;
    hooks.get('onResponse')?.(unmatchedRequest, unmatchedReply, vi.fn());
    expect(eligibleCount).toHaveBeenCalledTimes(eligibilityCalls);
  });
});
