import { hasHttpStatus } from '../../platform/http/problems/status.js';

import { singleHeader } from '../requests/headers.js';
import { WEBHOOK_BODY_MAX_BYTES as MAX_BODY } from '../requests/body.js';

import {
  allowWebhookOrigin,
  webhookOriginAllowed,
  webhookPreflightHeaders,
} from '../authentication/cors.js';
import { createWebhookResponseWaiter } from '../responses/wait.js';

import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  REJECTED_ATTEMPT,
  recordRejectedAttempt,
  type RejectedAttempt,
} from '../management/delivery-log.js';
import { authenticationFailed, problem, record } from './reply.js';
import {
  createWebhookIngressTelemetry,
  type WebhookIngressTelemetry,
} from './telemetry.js';
import {
  parseRequestId,
  withRequestOperationSignal,
} from '../../platform/http/index.js';
import { parseWebhookBody } from '../requests/body.js';
import {
  rawWebhookQuery,
  searchFields,
  webhookHeaders,
} from '../requests/details.js';
import type {
  WebhookIngressDependencies,
  WebhookMethod,
  WebhookAcceptanceOptions,
} from './contract.js';
import { prepareWebhookRequest } from './prepare.js';
import { preflightVerification, resolveIngressReference } from './resolve.js';
import { authenticateIngressRequest } from './authenticate.js';
import { captureIngressTestEvent, admitIngressDelivery } from './accept.js';

export { type WebhookIngressDependencies } from './contract.js';
export function registerWebhookIngress(
  fastify: FastifyInstance,
  dependencies: WebhookIngressDependencies,
): void {
  const telemetry = dependencies.telemetry ?? createWebhookIngressTelemetry();
  const responseWaiter = createWebhookResponseWaiter((input) =>
    dependencies.database.readResponse(input),
  );
  fastify.addHook('preClose', (done) => {
    responseWaiter.close();
    done();
  });
  void fastify.register((scope, _options, done) => {
    scope.setErrorHandler(async (error, request, reply) => {
      const requestId =
        parseRequestId(request.headers['x-request-id']) ?? randomUUID();
      if (hasHttpStatus(error, 413)) {
        record(() => {
          telemetry.delivery('invalid_request');
        });
        await problem(reply, 413, 'webhook.payload_too_large', requestId);
        return;
      }
      if (hasHttpStatus(error, 415)) {
        record(() => {
          telemetry.delivery('invalid_request');
        });
        await problem(reply, 415, 'webhook.unsupported_media_type', requestId);
        return;
      }
      record(() => {
        telemetry.delivery('unavailable');
      });
      record(() => {
        telemetry.health('degraded');
      });
      record(() => {
        dependencies.logger.error(
          'webhook.ingress_failed',
          { requestId },
          error,
        );
      });
      await problem(reply, 503, 'webhook.unavailable', requestId);
    });
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_BODY + 1 },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );
    const accept =
      (
        method: WebhookMethod,
        {
          testEvent = false,
        }: Readonly<{ testEvent?: boolean | undefined }> = {},
      ) =>
      (request: FastifyRequest, reply: FastifyReply) =>
        traceAcceptance(telemetry, singleHeader(request, 'traceparent'), () =>
          withRequestOperationSignal(request, (signal) =>
            acceptWebhook(request, reply, {
              method: method,
              dependencies: dependencies,
              telemetry: telemetry,
              encryptionSignal: signal,
              responseWaiter: responseWaiter,
              testEvent: testEvent,
            }),
          ),
        );
    scope.post(
      '/hooks/:endpointKey',
      { bodyLimit: MAX_BODY + 1 },
      accept('POST'),
    );
    scope.post(
      '/hooks/:endpointKey/test',
      { bodyLimit: MAX_BODY + 1 },
      accept('POST', { testEvent: true }),
    );
    scope.get(
      '/hooks/:endpointKey/test',
      { exposeHeadRoute: false },
      accept('GET', { testEvent: true }),
    );
    // A HEAD probe must never start a run.
    scope.get('/hooks/:endpointKey', { exposeHeadRoute: false }, accept('GET'));
    done();
  });
}

function traceAcceptance<T>(
  telemetry: WebhookIngressTelemetry,
  traceparent: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  let acceptancePromise: Promise<T> | undefined;
  const acceptOnce = (): Promise<T> => {
    acceptancePromise ??= Promise.resolve().then(work);
    return acceptancePromise;
  };
  let tracePromise: Promise<T> | undefined;
  try {
    tracePromise = telemetry.trace(traceparent, acceptOnce);
  } catch {
    return acceptOnce();
  }
  void Promise.resolve(tracePromise).catch(() => undefined);
  return acceptancePromise ?? acceptOnce();
}

async function acceptWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  options: WebhookAcceptanceOptions,
): Promise<void> {
  const { method, dependencies, telemetry, testEvent } = options;
  const prepared = await prepareWebhookRequest(request, reply, options);
  if (prepared === undefined) return;
  const { requestId, body, mediaType } = prepared;
  const references = await resolveIngressReference(reply, {
    prepared,
    options,
  });
  if (references === undefined) return;
  const { verification, productionReference } = references;

  // ADR 045: from here on every rejection is attributed to this endpoint.
  const reject = (attempt: RejectedAttempt) =>
    productionReference === null
      ? Promise.resolve()
      : recordRejectedAttempt(
          dependencies.database,
          productionReference,
          body,
          attempt,
        );
  const verifiedSecretVersionId = await authenticateIngressRequest(
    request,
    reply,
    { prepared, references, options, reject },
  );
  if (verifiedSecretVersionId === undefined) return;
  const parsed = parseWebhookBody(mediaType, body);
  if (!parsed.ok) {
    await reject(REJECTED_ATTEMPT.invalidRequest);
    record(() => {
      telemetry.delivery('invalid_request');
    });
    await problem(reply, 400, parsed.problem, requestId);
    return;
  }
  const requestData = {
    method,
    body: parsed.value,
    query: searchFields(rawWebhookQuery(request)),
    headers: webhookHeaders(request, verification.authentication),
  };
  if (testEvent) {
    await captureIngressTestEvent(reply, {
      options,
      verification,
      requestId,
      requestData,
    });
    return;
  }
  if (productionReference === null)
    throw new Error('Production webhook reference is unavailable');
  await admitIngressDelivery(request, reply, {
    options,
    prepared,
    references: { productionReference, verification },
    verifiedSecretVersionId,
    requestData,
    reject,
  });
}

export function createWebhookPreflight(
  dependencies: Pick<
    WebhookIngressDependencies,
    'database' | 'telemetry' | 'testEvents' | 'logger'
  >,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const telemetry = dependencies.telemetry ?? createWebhookIngressTelemetry();
  return async (request, reply) => {
    try {
      await preflightWebhook(request, reply, dependencies, telemetry);
    } catch (error: unknown) {
      const requestId = randomUUID();
      record(() => {
        telemetry.delivery('unavailable');
      });
      record(() => {
        telemetry.health('degraded');
      });
      record(() => {
        dependencies.logger.error(
          'webhook.preflight_failed',
          { requestId },
          error,
        );
      });
      await problem(reply, 503, 'webhook.unavailable', requestId);
    }
  };
}

async function preflightWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: Pick<WebhookIngressDependencies, 'database' | 'testEvents'>,
  telemetry: WebhookIngressTelemetry,
): Promise<void> {
  const requestId = randomUUID();
  const key = (request.params as { endpointKey: string }).endpointKey;
  const origin = singleHeader(request, 'origin');
  const testEvent = request.routeOptions.url?.endsWith('/test') ?? false;
  const verification = await preflightVerification(dependencies, key, {
    testEvent,
  });
  if (verification === null) {
    await authenticationFailed(reply, requestId, telemetry);
    return;
  }
  const invalidPreflight =
    origin === undefined ||
    !webhookOriginAllowed(verification.authentication, origin) ||
    !['GET', 'POST'].includes(
      singleHeader(request, 'access-control-request-method') ?? '',
    );
  if (invalidPreflight) {
    await authenticationFailed(reply, requestId, telemetry);
    return;
  }
  // Unlike credential inputs this is an HTTP comma-separated header-name list.
  const rawHeaders = request.headers['access-control-request-headers'];
  const headers = webhookPreflightHeaders(
    verification.authentication,
    typeof rawHeaders === 'string' ? rawHeaders : undefined,
  );
  if (headers === undefined) {
    await authenticationFailed(reply, requestId, telemetry);
    return;
  }
  allowWebhookOrigin(reply, origin);
  reply
    .header(
      'vary',
      'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    )
    .header('access-control-allow-methods', 'GET, POST');
  if (headers.length > 0)
    reply.header('access-control-allow-headers', headers.join(', '));
  await reply.code(204).send();
}
