import { API_PROBLEM_MANIFEST } from '@pertexo/contracts';
import { toProblem } from '../../problems/registry.js';
import { hasHttpStatus } from '../../platform/http/problems/status.js';
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
import { problem } from '../ingress/reply.js';
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
        hasHttpStatus(error, 413)
      ) {
        await problem(reply, 413, 'webhook.payload_too_large', requestId);
      } else if (error instanceof CallbackResponseError) {
        const mapped = toProblem(error);
        await problem(
          reply,
          API_PROBLEM_MANIFEST[mapped.code].status,
          mapped.code,
          requestId,
        );
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
    await acceptCallbackPreflight(request, reply, {
      authentication,
      origin,
      rejectAuthentication,
    });
    return;
  }
  if (authentication.mode !== 'signed' && headerPresent(request, 'origin')) {
    if (origin === undefined || !webhookOriginAllowed(authentication, origin)) {
      await rejectAuthentication();
      return;
    }
    allowWebhookOrigin(reply, origin);
  }
  const parsed = await readCallbackBody(request, reply, {
    callback,
    keys,
    requestId,
    rejectAuthentication,
  });
  if (parsed === undefined) return;
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
  await reply.code(202).send({ accepted: true });
}

async function acceptCallbackPreflight(
  request: FastifyRequest,
  reply: FastifyReply,
  {
    authentication,
    origin,
    rejectAuthentication,
  }: Readonly<{
    authentication: Parameters<typeof webhookOriginAllowed>[0];
    origin: string | undefined;
    rejectAuthentication(): Promise<void>;
  }>,
): Promise<void> {
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

async function readCallbackBody(
  request: FastifyRequest,
  reply: FastifyReply,
  {
    callback,
    keys,
    requestId,
    rejectAuthentication,
  }: Readonly<{
    callback: Parameters<typeof verifyCallbackRequest>[2];
    keys: Parameters<typeof verifyCallbackRequest>[3];
    requestId: string;
    rejectAuthentication(): Promise<void>;
  }>,
): Promise<
  | Extract<ReturnType<typeof parseWebhookBody>, Readonly<{ ok: true }>>
  | undefined
> {
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

  return parsed;
}
