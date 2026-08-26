import { metrics, type Meter } from '@opentelemetry/api';
import { API_PROBLEM_CODES } from '@pertexo/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const API_METRIC_NAME = Object.freeze({
  eligibleRequests: 'pertexo.api.eligible_request.count',
  requestDuration: 'pertexo.api.request.duration',
  requests: 'pertexo.api.request.count',
});

const problemCodes = new Set<string>(API_PROBLEM_CODES);

function statusClass(statusCode: number): string {
  return `${String(Math.floor(statusCode / 100))}xx`;
}

function routeTemplate(request: FastifyRequest): string {
  const route = request.routeOptions.url;
  return typeof route === 'string' && route.length > 0 && route.length <= 256
    ? route
    : 'unmatched';
}

function parseProblemCode(payload: unknown): string {
  if (typeof payload !== 'string' || payload.length > 16_384) return 'none';
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null || !('code' in parsed))
      return 'none';
    const code = (parsed as { readonly code?: unknown }).code;
    return typeof code === 'string' && problemCodes.has(code)
      ? code
      : 'invalid';
  } catch {
    return 'none';
  }
}

function eligible(route: string): boolean {
  return route !== '/health/live' && route !== '/health/ready';
}

export function registerApiMetrics(
  server: FastifyInstance,
  meter: Meter = metrics.getMeter('@pertexo/api.http', '0.0.0'),
): void {
  const requests = meter.createCounter(API_METRIC_NAME.requests, {
    description: 'API requests by bounded route template and response class',
    unit: '{request}',
  });
  const eligibleRequests = meter.createCounter(
    API_METRIC_NAME.eligibleRequests,
    {
      description: 'SLO-eligible API requests by bounded outcome',
      unit: '{request}',
    },
  );
  const duration = meter.createHistogram(API_METRIC_NAME.requestDuration, {
    description:
      'API request duration by bounded route template and response class',
    unit: 's',
  });
  const startedAt = new WeakMap<FastifyRequest, bigint>();
  const responseProblemCodes = new WeakMap<FastifyRequest, string>();

  server.addHook('onRequest', (request, _reply, done) => {
    startedAt.set(request, process.hrtime.bigint());
    done();
  });
  server.addHook('onSend', (request, reply, payload, done) => {
    responseProblemCodes.set(
      request,
      reply.statusCode >= 400 ? parseProblemCode(payload) : 'none',
    );
    done(null, payload);
  });
  server.addHook(
    'onResponse',
    (request: FastifyRequest, reply: FastifyReply, done) => {
      const route = routeTemplate(request);
      const attributes = {
        method: request.method,
        problem_code: responseProblemCodes.get(request) ?? 'none',
        route,
        status_class: statusClass(reply.statusCode),
      };
      requests.add(1, attributes);
      const start = startedAt.get(request);
      if (start !== undefined) {
        duration.record(
          Number(process.hrtime.bigint() - start) / 1_000_000_000,
          attributes,
        );
      }
      if (eligible(route)) {
        eligibleRequests.add(1, {
          outcome:
            reply.statusCode < 500
              ? 'eligible_success'
              : reply.statusCode === 503
                ? 'capacity_shed'
                : 'eligible_failure',
          route,
        });
      }
      done();
    },
  );
}
