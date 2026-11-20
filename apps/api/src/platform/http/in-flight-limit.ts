import { randomUUID } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { API_PROBLEM_MANIFEST } from '@pertexo/contracts';
import type { StructuredLogger } from '@pertexo/observability/server';
import type { FastifyInstance } from 'fastify';

import { HEALTH_PATHS } from '../health/health-paths.js';
import { parseRequestId } from './request-context.js';

/** How long a turned-away caller waits before trying again. */
const SERVER_BUSY_RETRY_AFTER_SECONDS = 1;
/** At most one warning per this long while the API turns requests away. */
const SHED_WARNING_INTERVAL_MILLIS = 60_000;

const BUSY = API_PROBLEM_MANIFEST['server.busy'];
// An orchestrator restarts a busy-but-healthy API if its probes are refused.
const EXEMPT_ROUTES = new Set<string>([HEALTH_PATHS.live, HEALTH_PATHS.ready]);

export type InFlightLimitOptions = Readonly<{
  limit: number;
  logger: Pick<StructuredLogger, 'warn'>;
  now?: () => number;
}>;

/**
 * Holds at most `limit` requests at once across the process. Past it a
 * request is answered 503 before any body is read, since each one held costs
 * memory while it waits (mostly for a database connection). Registered before
 * every route and body parser, so it sees each request first.
 */
export function registerInFlightLimit(
  fastify: FastifyInstance,
  { limit, logger, now = Date.now }: InFlightLimitOptions,
): void {
  let inFlight = 0;
  const shedWarning = createShedWarning(logger, limit, now);
  fastify.addHook('onRequest', (request, reply, done) => {
    const route = request.routeOptions.url;
    if (route !== undefined && EXEMPT_ROUTES.has(route)) {
      done();
      return;
    }
    if (inFlight >= limit) {
      shedWarning.shed();
      const requestId =
        parseRequestId(request.headers['x-request-id']) ?? randomUUID();
      void reply
        .code(HttpStatus.SERVICE_UNAVAILABLE)
        .header('retry-after', String(SERVER_BUSY_RETRY_AFTER_SECONDS))
        .header('x-request-id', requestId)
        .type('application/problem+json')
        .send({
          type: BUSY.type,
          title: BUSY.title,
          status: BUSY.status,
          code: 'server.busy',
          requestId,
        });
      return;
    }
    inFlight += 1;
    // 'close' follows both a finished response and a socket closed mid-body.
    reply.raw.once('close', () => {
      inFlight -= 1;
    });
    done();
  });
}

function createShedWarning(
  logger: InFlightLimitOptions['logger'],
  limit: number,
  now: () => number,
): Readonly<{ shed(): void }> {
  let shedSinceWarning = 0;
  let warnedAt: number | undefined;
  return {
    shed(): void {
      shedSinceWarning += 1;
      const at = now();
      if (
        warnedAt !== undefined &&
        at - warnedAt < SHED_WARNING_INTERVAL_MILLIS
      )
        return;
      logger.warn('http.server_busy', {
        inFlightLimit: limit,
        shedSinceLastWarning: shedSinceWarning,
        memoryMib: memoryMib(),
      });
      warnedAt = at;
      shedSinceWarning = 0;
    },
  };
}

const BYTES_PER_MIB = 1_024 * 1_024;

/** How full the process is when it turns work away, for the operator. */
function memoryMib(): Readonly<Record<string, number>> {
  const usage = process.memoryUsage();
  return {
    rss: Math.round(usage.rss / BYTES_PER_MIB),
    heapUsed: Math.round(usage.heapUsed / BYTES_PER_MIB),
    heapTotal: Math.round(usage.heapTotal / BYTES_PER_MIB),
    external: Math.round(usage.external / BYTES_PER_MIB),
  };
}
