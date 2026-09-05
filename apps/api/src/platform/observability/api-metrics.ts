import { metrics, type Meter } from '@opentelemetry/api';
import { API_PROBLEM_CODES } from '@pertexo/contracts/errors';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const API_METRIC_NAME = Object.freeze({
  availabilityRequests: 'pertexo.api.availability_request.count',
  requestDuration: 'pertexo.api.request.duration',
  requests: 'pertexo.api.request.count',
});

const problemCodes = new Set<string>(API_PROBLEM_CODES);
const excludedClientProblems = new Set<string>([
  'auth.forbidden',
  'auth.unauthenticated',
  'request.invalid',
  'request.precondition_required',
  'webhook.authentication_failed',
  'webhook.invalid_json',
  'webhook.payload_too_large',
  'webhook.unsupported_media_type',
]);
const excludedQuotaProblems = new Set<string>([
  'webhook.rate_limited',
  'workspace.quota_exceeded',
]);
const validBusinessConflicts = new Set<string>([
  'connection.conflict',
  'connection.revoked',
  'request.idempotency_conflict',
  'run.not_cancelable',
  'webhook.idempotency_conflict',
  'workflow.not_published',
  'workflow.revision_conflict',
  'workspace.conflict',
]);
const correctnessFailures = new Set<string>([
  'run.outcome_unknown',
  'workflow.activation_failed',
]);

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
  return (
    route !== 'unmatched' &&
    route !== '/health/live' &&
    route !== '/health/ready'
  );
}

function availabilityOutcome(statusCode: number, problem: string): string {
  if (excludedClientProblems.has(problem)) return 'excluded_client';
  if (excludedQuotaProblems.has(problem)) return 'excluded_tenant_quota';
  if (statusCode >= 200 && statusCode < 300) return 'eligible_success';
  if (validBusinessConflicts.has(problem)) return 'eligible_success';
  if (
    correctnessFailures.has(problem) ||
    statusCode >= 500 ||
    statusCode === 429
  )
    return 'eligible_failure';
  return 'excluded_client';
}

export function registerApiMetrics(
  server: FastifyInstance,
  meter: Meter = metrics.getMeter('@pertexo/api.http', '0.0.0'),
): void {
  const requests = meter.createCounter(API_METRIC_NAME.requests, {
    description: 'API requests by bounded route template and response class',
    unit: '{request}',
  });
  const availabilityRequests = meter.createCounter(
    API_METRIC_NAME.availabilityRequests,
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
        const problem = responseProblemCodes.get(request) ?? 'none';
        availabilityRequests.add(1, {
          outcome: availabilityOutcome(reply.statusCode, problem),
          route,
        });
      }
      done();
    },
  );
}
