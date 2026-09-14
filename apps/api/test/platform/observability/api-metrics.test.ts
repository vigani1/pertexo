import type { Meter } from '@opentelemetry/api';
import { API_PROBLEM_MANIFEST } from '@pertexo/contracts/errors';
import { describe, expect, it, vi } from 'vitest';

import {
  API_METRIC_NAME,
  registerApiMetrics,
} from '../../../src/platform/observability/api-metrics.js';

type Hook = (...arguments_: unknown[]) => unknown;

function metricsFixture() {
  const hooks = new Map<string, Hook>();
  const requestCount = vi.fn();
  const eligibleCount = vi.fn();
  const duration = vi.fn();
  const createCounter = vi.fn((name: string) => ({
    add:
      name === API_METRIC_NAME.availabilityRequests
        ? eligibleCount
        : requestCount,
  }));
  const meter = {
    createCounter,
    createHistogram: vi.fn(() => ({ record: duration })),
  } as unknown as Meter;
  const server = {
    addHook: vi.fn((name: string, hook: Hook) => hooks.set(name, hook)),
  };
  const times = [1_000_000_000n, 3_500_000_000n];
  registerApiMetrics(server as never, meter, {
    now: () => times.shift() ?? 3_500_000_000n,
  });
  expect([...hooks.keys()]).toEqual(['onRequest', 'onSend', 'onResponse']);

  function invoke(input: {
    method?: string;
    payload?: unknown;
    route?: string;
    status: number;
  }) {
    const request = {
      method: input.method ?? 'GET',
      routeOptions: input.route === undefined ? {} : { url: input.route },
    };
    const reply = { statusCode: input.status };
    const onRequestDone = vi.fn();
    const onSendDone = vi.fn();
    const onResponseDone = vi.fn();
    const payload = input.payload ?? '';
    requireHook(hooks, 'onRequest')(request, reply, onRequestDone);
    requireHook(hooks, 'onSend')(request, reply, payload, onSendDone);
    requireHook(hooks, 'onResponse')(request, reply, onResponseDone);
    expect(onRequestDone).toHaveBeenCalledOnce();
    expect(onSendDone).toHaveBeenCalledOnce();
    expect(onSendDone).toHaveBeenCalledWith(null, payload);
    expect(onResponseDone).toHaveBeenCalledOnce();
    return { reply, request };
  }

  return { createCounter, duration, eligibleCount, invoke, requestCount };
}

function requireHook(hooks: Map<string, Hook>, name: string): Hook {
  const hook = hooks.get(name);
  if (hook === undefined) throw new Error(`${name} hook was not registered`);
  return hook;
}

describe('API metrics', () => {
  it('registers bounded counters and records exact controlled duration', () => {
    const fixture = metricsFixture();
    fixture.invoke({
      route: '/v1/workspaces/:workspaceId/runs/:runId',
      status: 503,
      payload: JSON.stringify({ code: 'provider.unavailable' }),
    });

    expect(fixture.createCounter).toHaveBeenCalledWith(
      API_METRIC_NAME.requests,
      expect.any(Object),
    );
    expect(fixture.requestCount).toHaveBeenCalledWith(1, {
      method: 'GET',
      problem_code: 'provider.unavailable',
      route: '/v1/workspaces/:workspaceId/runs/:runId',
      status_class: '5xx',
    });
    expect(fixture.duration).toHaveBeenCalledWith(2.5, {
      method: 'GET',
      problem_code: 'provider.unavailable',
      route: '/v1/workspaces/:workspaceId/runs/:runId',
      status_class: '5xx',
    });
  });

  it.each([
    ['success', 200, 'none', 'eligible_success'],
    [
      'business conflict',
      412,
      'workflow.revision_conflict',
      'eligible_success',
    ],
    [
      'authentication exclusion',
      401,
      'auth.unauthenticated',
      'excluded_client',
    ],
    ['input exclusion', 400, 'request.invalid', 'excluded_client'],
    ['tenant quota', 429, 'workspace.quota_exceeded', 'excluded_tenant_quota'],
    ['generic backpressure', 429, 'provider.rate_limited', 'eligible_failure'],
    [
      'correctness failure',
      409,
      'workflow.activation_failed',
      'eligible_failure',
    ],
    ['server failure', 503, 'provider.unavailable', 'eligible_failure'],
  ] as const)('classifies %s as %s', (_name, status, code, expectedOutcome) => {
    const fixture = metricsFixture();
    fixture.invoke({
      method: 'POST',
      route: '/v1/workspaces/:workspaceId/workflows/:workflowId/runs',
      status,
      payload: code === 'none' ? '{}' : JSON.stringify({ code }),
    });

    expect(fixture.eligibleCount).toHaveBeenCalledOnce();
    expect(fixture.eligibleCount).toHaveBeenCalledWith(1, {
      outcome: expectedOutcome,
      route: '/v1/workspaces/:workspaceId/workflows/:workflowId/runs',
    });
  });

  it.each(['/health/live', '/health/ready'])(
    'excludes the %s route from availability',
    (route) => {
      const fixture = metricsFixture();
      fixture.invoke({ route, status: 200 });

      expect(fixture.requestCount).toHaveBeenCalledOnce();
      expect(fixture.eligibleCount).not.toHaveBeenCalled();
    },
  );

  it('bounds unmatched routes and excludes them from availability', () => {
    const fixture = metricsFixture();
    fixture.invoke({ status: 404, payload: '{}' });

    expect(fixture.requestCount).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ route: 'unmatched' }),
    );
    expect(fixture.eligibleCount).not.toHaveBeenCalled();
  });

  it.each([
    ['non-string', { code: 'provider.unavailable' }, 'none'],
    ['malformed', '{', 'none'],
    ['oversized', 'x'.repeat(16_385), 'none'],
    ['unknown code', JSON.stringify({ code: 'private.code' }), 'invalid'],
  ])(
    'uses a bounded label for a %s problem payload',
    (_name, payload, expected) => {
      const fixture = metricsFixture();
      fixture.invoke({ route: '/v1/node-tests', status: 503, payload });

      expect(fixture.requestCount).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ problem_code: expected }),
      );
    },
  );

  it('classifies every manifest 5xx response as an eligible failure', () => {
    for (const [code, manifest] of Object.entries(API_PROBLEM_MANIFEST)) {
      if (manifest.status < 500) continue;
      const fixture = metricsFixture();
      fixture.invoke({
        route: '/v1/node-tests',
        status: manifest.status,
        payload: JSON.stringify({ code }),
      });
      expect(fixture.eligibleCount).toHaveBeenCalledWith(1, {
        outcome: 'eligible_failure',
        route: '/v1/node-tests',
      });
    }
  });
});
