import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CallbackResponseError } from '@pertexo/database/runs';
import { StoredExecutionValueInvalidError } from '@pertexo/database/platform';
import { callbackTokenHash, redactText } from '@pertexo/integrations/server';
import { AbuseRateLimitPolicy } from '@pertexo/rate-limit';
import type { ApiCallbackRuntime } from '../../platform/webhooks/callback-runtime.module.js';
import type { RateLimitConsumer } from '../../platform/rate-limit/admission.js';
import {
  parseRequestId,
  withRequestOperationSignal,
} from '../../platform/http/index.js';
import { problem } from '../ingress-responses.js';
import {
  WEBHOOK_BODY_MAX_BYTES,
  parseWebhookBody,
  webhookMediaType,
} from '../requests/body.js';
import { headerPresent, singleHeader } from '../requests/headers.js';
import { webhookHeaders } from '../requests/details.js';
import {
  allowWebhookOrigin,
  webhookOriginAllowed,
  webhookPreflightHeaders,
} from '../authentication/cors.js';
import { verifyCallbackRequest } from './authentication.js';

type Dependencies = Pick<ApiCallbackRuntime, 'store' | 'keys'> &
  Readonly<{ rateLimitConsumer: RateLimitConsumer }>;
const policy = new AbuseRateLimitPolicy();
export function registerCallbackIngress(
  fastify: FastifyInstance,
  dependencies: Dependencies,
): void {
  void fastify.register((scope, _options, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_MAX_BYTES + 1 },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );
    scope.setErrorHandler(async (error, request, reply) => {
      const requestId =
        parseRequestId(request.headers['x-request-id']) ?? randomUUID();
      if (
        error instanceof StoredExecutionValueInvalidError ||
        (typeof error === 'object' &&
          error !== null &&
          'statusCode' in error &&
          error.statusCode === 413)
      ) {
        await problem(reply, 413, 'webhook.payload_too_large', requestId);
      } else await problem(reply, 503, 'callback.unavailable', requestId);
    });
    scope.addHook('onRequest', (_request, reply, next) => {
      reply.header('cache-control', 'no-store');
      next();
    });
    const handle = (request: FastifyRequest, reply: FastifyReply) =>
      withRequestOperationSignal(request, (signal) =>
        receive(request, reply, dependencies, signal),
      );
    scope.post(
      '/hooks/:endpointKey/resume',
      { bodyLimit: WEBHOOK_BODY_MAX_BYTES + 1 },
      handle,
    );
    scope.options('/hooks/:endpointKey/resume', handle);
    const methodRefused = async (
      _request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      reply.header('allow', 'POST, OPTIONS');
      await problem(reply, 405, 'webhook.method_not_allowed', randomUUID());
    };
    scope.get(
      '/hooks/:endpointKey/resume',
      { exposeHeadRoute: false },
      methodRefused,
    );
    scope.head('/hooks/:endpointKey/resume', methodRefused);
    done();
  });
}
async function receive(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: Dependencies,
  signal: AbortSignal,
): Promise<void> {
  const requestId =
    parseRequestId(request.headers['x-request-id']) ?? randomUUID();
  const token = (request.params as { endpointKey: string }).endpointKey;
  const rejectAuthentication = () =>
    problem(reply, 401, 'webhook.authentication_failed', requestId);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    await rejectAuthentication();
    return;
  }
  const hash = callbackTokenHash(token);
  let admitted;
  try {
    admitted = await dependencies.rateLimitConsumer.consume(
      policy.evaluate('callback_ingress', {
        clientAddress: request.ip,
        tokenId: hash,
      }),
    );
  } catch {
    await problem(reply, 503, 'request.rate_limit_unavailable', requestId);
    return;
  }
  if (!admitted.allowed) {
    reply.header('retry-after', String(admitted.retryAfterSeconds));
    await problem(reply, 429, 'request.rate_limited', requestId);
    return;
  }
  const callback = await dependencies.store.resolve(hash, signal);
  if (callback === null) {
    await rejectAuthentication();
    return;
  }
  const keys = dependencies.keys;
  if (keys === undefined) {
    await problem(reply, 503, 'callback.unavailable', requestId);
    return;
  }
  const material = keys.material(callback, callback.keyVersion);
  if (callbackTokenHash(material.token) !== hash) {
    await problem(reply, 503, 'callback.unavailable', requestId);
    return;
  }
  const authentication = callback.config.authentication;
  const origin = singleHeader(request, 'origin');
  if (request.method === 'OPTIONS') {
    if (
      origin === undefined ||
      !webhookOriginAllowed(authentication, origin) ||
      singleHeader(request, 'access-control-request-method') !== 'POST'
    ) {
      await rejectAuthentication();
      return;
    }
    const requested = singleHeader(request, 'access-control-request-headers');
    const headers = webhookPreflightHeaders(authentication, requested);
    if (headers === undefined) {
      await rejectAuthentication();
      return;
    }
    allowWebhookOrigin(reply, origin);
    reply
      .header(
        'vary',
        'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
      )
      .header('access-control-allow-methods', 'POST');
    if (headers.length > 0)
      reply.header('access-control-allow-headers', headers.join(', '));
    await reply.code(204).send();
    return;
  }
  if (authentication.mode !== 'signed' && headerPresent(request, 'origin')) {
    if (origin === undefined || !webhookOriginAllowed(authentication, origin)) {
      await rejectAuthentication();
      return;
    }
    allowWebhookOrigin(reply, origin);
  }
  const body = request.body ?? new Uint8Array();
  if (
    !(body instanceof Uint8Array) ||
    body.byteLength > WEBHOOK_BODY_MAX_BYTES
  ) {
    await problem(reply, 413, 'webhook.payload_too_large', requestId);
    return;
  }
  const contentType = singleHeader(request, 'content-type');
  const mediaType =
    contentType === undefined && headerPresent(request, 'content-type')
      ? undefined
      : webhookMediaType(contentType, body.byteLength);
  if (mediaType === undefined || headerPresent(request, 'content-encoding')) {
    await problem(reply, 415, 'webhook.unsupported_media_type', requestId);
    return;
  }
  if (!verifyCallbackRequest(request, body, callback, keys)) {
    await rejectAuthentication();
    return;
  }
  const parsed = parseWebhookBody(mediaType, body);
  if (!parsed.ok) {
    await problem(reply, 400, parsed.problem, requestId);
    return;
  }
  try {
    await dependencies.store.respond({
      callback,
      output: {
        body: parsed.value,
        headers: webhookHeaders(request, authentication),
      },
      redactOutput: (canonical) =>
        redactText(canonical, [material.token, material.secret]),
      signal,
    });
  } catch (error) {
    if (error instanceof CallbackResponseError) {
      await problem(
        reply,
        error.reason === 'resolved' ? 409 : 410,
        error.reason === 'resolved'
          ? 'callback.already_received'
          : 'callback.expired',
        requestId,
      );
      return;
    }
    throw error;
  }
  await reply.code(202).send({ accepted: true });
}
