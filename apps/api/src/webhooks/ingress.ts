import { createHash, randomUUID } from 'node:crypto';

import { API_PROBLEM_MANIFEST } from '@pertexo/contracts/errors';
import type { ApiProblemCode } from '@pertexo/contracts/errors';

import {
  WebhookDeliveryIneligibleError,
  WebhookDeliveryReplayMismatchError,
  WebhookIngressRateLimitExceededError,
  RegionalWriteAdmissionPausedError,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
  type WebhookCheckpointFactory,
  type WebhookTriggerDatabase,
  type WebhookVerificationReference,
} from '@pertexo/database/api';
import {
  verifyWebhookSignature,
  type WebhookTriggerEnvelopeEncryption,
} from '@pertexo/integrations/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  createWebhookIngressTelemetry,
  type WebhookIngressTelemetry,
} from './telemetry.js';
import {
  parseRequestId,
  withRequestOperationSignal,
} from '../platform/http/index.js';

const MAX_BODY = 256 * 1024;
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const IDEMPOTENCY_KEY = /^[\x21-\x2b\x2d-\x7e]{1,128}$/u;

export type WebhookIngressDependencies = Readonly<{
  database: WebhookTriggerDatabase;
  encryption: WebhookTriggerEnvelopeEncryption;
  checkpointFactory: WebhookCheckpointFactory;
  telemetry?: WebhookIngressTelemetry;
}>;

export function registerWebhookIngress(
  fastify: FastifyInstance,
  dependencies: WebhookIngressDependencies,
): void {
  const telemetry = dependencies.telemetry ?? createWebhookIngressTelemetry();
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
        telemetry.trace(singleHeader(request, 'traceparent'), () =>
          withRequestOperationSignal(request, (signal) =>
            acceptWebhook(request, reply, dependencies, telemetry, signal),
          ),
        ),
    );
    done();
  });
}

async function acceptWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: WebhookIngressDependencies,
  telemetry: WebhookIngressTelemetry,
  encryptionSignal: AbortSignal,
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
    !JSON_MEDIA_TYPE.test(contentType) ||
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
    !/^[A-Za-z0-9_-]{43}$/u.test(endpointKey) ||
    timestamp === undefined ||
    signature === undefined
  ) {
    await authenticationFailed(reply, requestId, telemetry);
    return;
  }
  const verification = await dependencies.database.resolveVerification(
    sha256(endpointKey),
  );
  if (verification === null || !/^\d{1,16}$/u.test(timestamp)) {
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
  const seconds = Number(timestamp);
  if (
    !Number.isSafeInteger(seconds) ||
    Math.abs(verification.databaseTime.getTime() / 1000 - seconds) > 300
  ) {
    await authenticationFailed(reply, requestId, telemetry);
    return;
  }

  let current: Uint8Array | undefined;
  let previous: Uint8Array | undefined;
  try {
    current = await openSecret(
      dependencies.encryption,
      verification.currentSecret,
      verification,
      encryptionSignal,
    );
    const currentValid = verifyWebhookSignature({
      secret: current,
      timestamp,
      signature,
      rawBody: body,
    });
    const previousReference = verification.previousSecret;
    const previousEligible =
      previousReference !== undefined &&
      verification.databaseTime.getTime() <
        previousReference.validUntil.getTime();
    let previousValid = false;
    if (previousEligible) {
      previous = await openSecret(
        dependencies.encryption,
        previousReference,
        verification,
        encryptionSignal,
      );
      previousValid = verifyWebhookSignature({
        secret: previous,
        timestamp,
        signature,
        rawBody: body,
      });
    }
    if (!currentValid && !previousValid) {
      await authenticationFailed(reply, requestId, telemetry);
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(body),
      ) as unknown;
    } catch {
      record(() => {
        telemetry.delivery('invalid_request');
      });
      await problem(reply, 400, 'webhook.invalid_json', requestId);
      return;
    }
    const idempotency = optionalIdempotencyKey(request);
    if (idempotency === null) {
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
      const traceparent = telemetry.traceparent();
      const verifiedSecretVersionId = currentValid
        ? verification.currentSecret.id
        : previousReference?.id;
      if (verifiedSecretVersionId === undefined) {
        await authenticationFailed(reply, requestId, telemetry);
        return;
      }
      encryptionSignal.throwIfAborted();
      const result = await dependencies.database.acceptVerifiedDelivery({
        verification,
        verifiedSecretVersionId,
        requestFingerprint: fingerprint,
        ...(idempotency === undefined
          ? {}
          : { idempotencyKeyHash: sha256(idempotency) }),
        payload,
        checkpointFactory: dependencies.checkpointFactory,
        ...(traceparent === undefined ? {} : { traceparent }),
      });
      record(() => {
        telemetry.delivery(result.replayed ? 'replayed' : 'accepted');
      });
      record(() => {
        telemetry.deduplication(result.replayed ? 'replayed' : 'new');
      });
      record(() => {
        telemetry.health('healthy');
      });
      await reply.code(202).send(result);
    } catch (error) {
      if (error instanceof WebhookDeliveryReplayMismatchError) {
        record(() => {
          telemetry.delivery('conflict');
        });
        record(() => {
          telemetry.deduplication('conflict');
        });
        await problem(reply, 409, 'webhook.idempotency_conflict', requestId);
        return;
      }
      if (error instanceof WorkspaceRunQuotaExceededError) {
        record(() => {
          telemetry.delivery('rate_limited');
        });
        reply.header('retry-after', String(error.retryAfterSeconds));
        await problem(reply, 429, 'webhook.rate_limited', requestId);
        return;
      }
      if (error instanceof RegionalWriteAdmissionPausedError) {
        record(() => {
          telemetry.delivery('unavailable');
        });
        record(() => {
          telemetry.health('degraded');
        });
        reply.header('retry-after', String(error.retryAfterSeconds));
        await problem(reply, 503, 'webhook.unavailable', requestId);
        return;
      }
      if (
        error instanceof WebhookDeliveryIneligibleError ||
        error instanceof WorkspaceRunAdmissionDeniedError
      ) {
        await authenticationFailed(reply, requestId, telemetry);
        return;
      }
      throw error;
    }
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
      schemaVersion: sealed.schemaVersion,
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
  return value !== undefined && IDEMPOTENCY_KEY.test(value) ? value : null;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function authenticationFailed(
  reply: FastifyReply,
  requestId: string,
  telemetry: WebhookIngressTelemetry,
): Promise<void> {
  record(() => {
    telemetry.delivery('authentication_failed');
  });
  await problem(reply, 401, 'webhook.authentication_failed', requestId);
}

function record(operation: () => void): void {
  try {
    operation();
  } catch {
    // Diagnostics cannot change webhook acceptance truth.
  }
}

async function problem(
  reply: FastifyReply,
  status: number,
  code: ApiProblemCode,
  requestId: string,
): Promise<void> {
  const definition = API_PROBLEM_MANIFEST[code];
  if (definition.status !== status)
    throw new Error('Webhook problem status does not match its manifest');
  await reply.code(definition.status).type('application/problem+json').send({
    type: definition.type,
    title: definition.title,
    status: definition.status,
    code,
    requestId,
  });
}
