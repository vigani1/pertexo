import { verifyWebhookHeaderSecret } from './authentication/header-secret.js';
import {
  allowWebhookOrigin,
  webhookOriginAllowed,
  webhookPreflightHeaders,
} from './authentication/cors.js';
import { createWebhookResponseWaiter } from './responses/wait.js';
import { replyToAcceptedWebhook } from './responses/reply.js';
import { createHash, randomUUID } from 'node:crypto';

import {
  idempotencyKeySchema,
  webhookJsonContentTypeSchema,
} from '@pertexo/contracts';

import {
  WebhookIngressRateLimitExceededError,
  type WebhookTriggerDatabase,
  type WebhookVerificationReference,
} from '@pertexo/database/triggers';
import type { InitialCheckpointFactory } from '@pertexo/database/runs';
import {
  verifyWebhookSignature,
  type WebhookTriggerEnvelopeEncryption,
} from '@pertexo/integrations/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  REJECTED_ATTEMPT,
  recordRejectedAttempt,
  type RejectedAttempt,
} from './delivery-log.js';
import {
  authenticationFailed,
  problem,
  record,
  rejectAcceptance,
} from './ingress-responses.js';
import {
  createWebhookIngressTelemetry,
  type WebhookIngressTelemetry,
} from './telemetry.js';
import {
  parseRequestId,
  withRequestOperationSignal,
} from '../platform/http/index.js';

const MAX_BODY = 256 * 1024;
const WEBHOOK_FRESHNESS_ALLOWANCE_SECONDS = 300;

export type WebhookIngressDependencies = Readonly<{
  database: WebhookTriggerDatabase;
  encryption: WebhookTriggerEnvelopeEncryption;
  checkpointFactory: InitialCheckpointFactory;
  telemetry?: WebhookIngressTelemetry;
}>;

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
      if (
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        error.statusCode === 413
      ) {
        record(() => {
          telemetry.delivery('invalid_request');
        });
        await problem(reply, 413, 'webhook.payload_too_large', requestId);
        return;
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        error.statusCode === 415
      ) {
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
    scope.post(
      '/hooks/:endpointKey',
      { bodyLimit: MAX_BODY + 1 },
      (request, reply) =>
        traceAcceptance(telemetry, singleHeader(request, 'traceparent'), () =>
          withRequestOperationSignal(request, (signal) =>
            acceptWebhook(
              request,
              reply,
              dependencies,
              telemetry,
              signal,
              responseWaiter,
            ),
          ),
        ),
    );
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
  dependencies: WebhookIngressDependencies,
  telemetry: WebhookIngressTelemetry,
  encryptionSignal: AbortSignal,
  responseWaiter: ReturnType<typeof createWebhookResponseWaiter>,
): Promise<void> {
  const requestId =
    parseRequestId(request.headers['x-request-id']) ?? randomUUID();
  const body = request.body;
  if (!(body instanceof Uint8Array)) {
    record(() => {
      telemetry.delivery('invalid_request');
    });
    await problem(reply, 400, 'webhook.invalid_json', requestId);
    return;
  }
  if (body.byteLength > MAX_BODY) {
    record(() => {
      telemetry.delivery('invalid_request');
    });
    await problem(reply, 413, 'webhook.payload_too_large', requestId);
    return;
  }
  const contentType = singleHeader(request, 'content-type');
  if (
    contentType === undefined ||
    !webhookJsonContentTypeSchema.safeParse(contentType).success ||
    headerPresent(request, 'content-encoding')
  ) {
    record(() => {
      telemetry.delivery('invalid_request');
    });
    await problem(reply, 415, 'webhook.unsupported_media_type', requestId);
    return;
  }

  const timestamp = singleHeader(request, 'x-pertexo-timestamp');
  const signature = singleHeader(request, 'x-pertexo-signature');
  const endpointKey = (request.params as { endpointKey?: unknown }).endpointKey;
  if (
    typeof endpointKey !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(endpointKey)
  ) {
    await authenticationFailed(reply, requestId, telemetry);
    return;
  }
  const verification = await dependencies.database.resolveVerification(
    sha256(endpointKey),
  );
  if (verification === null) {
    await authenticationFailed(reply, requestId, telemetry);
    return;
  }
  try {
    await dependencies.database.consumeIngressLimit(
      verification.endpointKeyHash,
    );
  } catch (error) {
    if (error instanceof WebhookIngressRateLimitExceededError) {
      record(() => {
        telemetry.delivery('rate_limited');
      });
      reply.header('retry-after', String(error.retryAfterSeconds));
      await problem(reply, 429, 'webhook.rate_limited', requestId);
      return;
    }
    throw error;
  }
  // ADR 045: from here on every rejection is attributed to this endpoint.
  const reject = (attempt: RejectedAttempt) =>
    recordRejectedAttempt(dependencies.database, verification, body, attempt);
  const origin = singleHeader(request, 'origin');
  if (
    verification.authentication.mode !== 'signed' &&
    headerPresent(request, 'origin')
  ) {
    if (
      origin === undefined ||
      !webhookOriginAllowed(verification.authentication, origin)
    ) {
      await reject(REJECTED_ATTEMPT.signatureMismatch);
      await authenticationFailed(reply, requestId, telemetry);
      return;
    }
    allowWebhookOrigin(reply, origin);
  }
  const policy = verification.authentication;
  let verifiedSecretVersionId: string | undefined;
  if (policy.mode === 'secret_url')
    verifiedSecretVersionId = verification.currentSecret.id;
  else if (policy.mode === 'header_secret') {
    const header = singleHeader(request, policy.headerName);
    const supplied =
      policy.headerName === 'authorization'
        ? header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/iu)?.[1]
        : header;
    if (supplied !== undefined && /^[A-Za-z0-9_-]{43}$/u.test(supplied))
      verifiedSecretVersionId = await verifyWebhookSecrets(
        dependencies.encryption,
        verification,
        { headerSecret: supplied },
        encryptionSignal,
      );
  } else {
    if (
      timestamp === undefined ||
      signature === undefined ||
      !/^\d{1,16}$/u.test(timestamp)
    ) {
      await reject(REJECTED_ATTEMPT.signatureMismatch);
      await authenticationFailed(reply, requestId, telemetry);
      return;
    }
    const seconds = Number(timestamp);
    if (
      !Number.isSafeInteger(seconds) ||
      Math.abs(verification.databaseTime.getTime() / 1000 - seconds) >
        WEBHOOK_FRESHNESS_ALLOWANCE_SECONDS
    ) {
      await reject(REJECTED_ATTEMPT.staleTimestamp);
      await authenticationFailed(reply, requestId, telemetry);
      return;
    }
    verifiedSecretVersionId = await verifyWebhookSecrets(
      dependencies.encryption,
      verification,
      { body, signature, timestamp },
      encryptionSignal,
    );
  }

  if (verifiedSecretVersionId === undefined) {
    await reject(REJECTED_ATTEMPT.signatureMismatch);
    await authenticationFailed(reply, requestId, telemetry);
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(body),
    ) as unknown;
  } catch {
    await reject(REJECTED_ATTEMPT.invalidRequest);
    record(() => {
      telemetry.delivery('invalid_request');
    });
    await problem(reply, 400, 'webhook.invalid_json', requestId);
    return;
  }
  const idempotency = optionalIdempotencyKey(request);
  if (idempotency === null) {
    await reject(REJECTED_ATTEMPT.invalidRequest);
    record(() => {
      telemetry.delivery('invalid_request');
    });
    await problem(reply, 400, 'request.invalid', requestId);
    return;
  }
  const fingerprint = sha256(
    `${verification.endpointId}\0${sha256(body)}\0application/json`,
  );
  try {
    const traceparent = diagnosticTraceparent(telemetry);
    encryptionSignal.throwIfAborted();
    const result = await dependencies.database.acceptVerifiedDelivery({
      verification,
      verifiedSecretVersionId,
      requestFingerprint: fingerprint,
      bodyBytes: body.byteLength,
      ...(idempotency === undefined
        ? {}
        : { idempotencyKeyHash: sha256(idempotency) }),
      payload,
      signal: encryptionSignal,
      checkpointFactory: dependencies.checkpointFactory,
      ...(traceparent === undefined ? {} : { traceparent }),
    });
    if ('coordinated' in result) {
      record(() => {
        telemetry.delivery('accepted');
      });
      await reply.code(202).send(result);
      return;
    }
    if ('skipped' in result) {
      record(() => {
        telemetry.delivery('skipped');
      });
      await reply.code(202).send(result);
      return;
    }
    record(() => {
      telemetry.delivery(result.replayed ? 'replayed' : 'accepted');
    });
    record(() => {
      telemetry.deduplication(result.replayed ? 'replayed' : 'new');
    });
    record(() => {
      telemetry.health('healthy');
    });
    await replyToAcceptedWebhook(
      request,
      reply,
      verification.workspaceId,
      result,
      responseWaiter,
      telemetry,
    );
  } catch (error) {
    await rejectAcceptance(error, reply, requestId, telemetry, reject);
  }
}

function diagnosticTraceparent(
  telemetry: WebhookIngressTelemetry,
): string | undefined {
  try {
    return telemetry.traceparent();
  } catch {
    return undefined;
  }
}

async function verifyWebhookSecrets(
  encryption: WebhookTriggerEnvelopeEncryption,
  verification: WebhookVerificationReference,
  request:
    | Readonly<{ body: Uint8Array; signature: string; timestamp: string }>
    | Readonly<{ headerSecret: string }>,
  signal: AbortSignal,
): Promise<string | undefined> {
  let current: Uint8Array | undefined;
  let previous: Uint8Array | undefined;
  try {
    current = await openSecret(
      encryption,
      verification.currentSecret,
      verification,
      signal,
    );
    const valid = (secret: Uint8Array) =>
      'headerSecret' in request
        ? verifyWebhookHeaderSecret(secret, request.headerSecret)
        : verifyWebhookSignature({
            secret,
            timestamp: request.timestamp,
            signature: request.signature,
            rawBody: request.body,
          });
    const currentValid = valid(current);
    const previousReference = verification.previousSecret;
    const previousEligible =
      previousReference !== undefined &&
      verification.databaseTime.getTime() <
        previousReference.validUntil.getTime();
    let previousValid = false;
    if (previousEligible) {
      previous = await openSecret(
        encryption,
        previousReference,
        verification,
        signal,
      );
      previousValid = valid(previous);
    }
    if (currentValid) return verification.currentSecret.id;
    return previousValid ? previousReference?.id : undefined;
  } finally {
    current?.fill(0);
    previous?.fill(0);
  }
}

async function openSecret(
  encryption: WebhookTriggerEnvelopeEncryption,
  sealed: WebhookVerificationReference['currentSecret'],
  verification: Pick<WebhookVerificationReference, 'workspaceId' | 'triggerId'>,
  signal: AbortSignal,
) {
  return encryption.open(
    {
      kmsKeyReference: sealed.kmsKeyReference,
      encryptedDataKey: sealed.encryptedDataKey,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      authTag: sealed.authTag,
    },
    {
      workspaceId: verification.workspaceId,
      triggerId: verification.triggerId,
      secretVersionId: sealed.id,
    },
    signal,
  );
}

function headerPresent(request: FastifyRequest, name: string): boolean {
  // Webhook verification reads raw headers intentionally: unlike ordinary HTTP
  // adaptation, duplicate or comma-folded signature inputs must be rejected.
  return request.raw.rawHeaders.some(
    (value, index) => index % 2 === 0 && value.toLowerCase() === name,
  );
}

function singleHeader(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const values: string[] = [];
  const raw = request.raw.rawHeaders;
  for (let index = 0; index < raw.length; index += 2)
    if (raw[index]?.toLowerCase() === name) values.push(raw[index + 1] ?? '');
  const value = values[0];
  return values.length === 1 && value !== undefined && !value.includes(',')
    ? value
    : undefined;
}

function optionalIdempotencyKey(
  request: FastifyRequest,
): string | undefined | null {
  if (!headerPresent(request, 'idempotency-key')) return undefined;
  const value = singleHeader(request, 'idempotency-key');
  return value !== undefined && idempotencyKeySchema.safeParse(value).success
    ? value
    : null;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createWebhookPreflight(
  dependencies: Pick<WebhookIngressDependencies, 'database' | 'telemetry'>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const telemetry = dependencies.telemetry ?? createWebhookIngressTelemetry();
  return async (request, reply) => {
    try {
      await preflightWebhook(request, reply, dependencies, telemetry);
    } catch {
      record(() => {
        telemetry.delivery('unavailable');
      });
      record(() => {
        telemetry.health('degraded');
      });
      await problem(reply, 503, 'webhook.unavailable', randomUUID());
    }
  };
}

async function preflightWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: Pick<WebhookIngressDependencies, 'database'>,
  telemetry: WebhookIngressTelemetry,
): Promise<void> {
  const requestId = randomUUID();
  const key = (request.params as { endpointKey: string }).endpointKey;
  const origin = singleHeader(request, 'origin');
  const verification = /^[A-Za-z0-9_-]{43}$/u.test(key)
    ? await dependencies.database.resolveVerification(sha256(key))
    : null;
  if (verification === null) {
    await authenticationFailed(reply, requestId, telemetry);
    return;
  }
  if (
    origin === undefined ||
    !webhookOriginAllowed(verification.authentication, origin) ||
    singleHeader(request, 'access-control-request-method') !== 'POST'
  ) {
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
    .header('access-control-allow-methods', 'POST');
  if (headers.length > 0)
    reply.header('access-control-allow-headers', headers.join(', '));
  await reply.code(204).send();
}
