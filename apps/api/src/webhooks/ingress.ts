import { createHash, randomUUID } from 'node:crypto';

import {
  WebhookDeliveryIneligibleError,
  WebhookDeliveryReplayMismatchError,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
  type WebhookCheckpointFactory,
  type WebhookTriggerDatabase,
  type WebhookVerificationReference,
} from '@pertexo/database';
import {
  verifyWebhookSignature,
  type WebhookTriggerEnvelopeEncryption,
} from '@pertexo/integrations/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const MAX_BODY = 256 * 1024;
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const IDEMPOTENCY_KEY = /^[\x21-\x2b\x2d-\x7e]{1,128}$/u;

export type WebhookIngressDependencies = Readonly<{
  database: WebhookTriggerDatabase;
  encryption: WebhookTriggerEnvelopeEncryption;
  checkpointFactory: WebhookCheckpointFactory;
}>;

export function registerWebhookIngress(
  fastify: FastifyInstance,
  dependencies: WebhookIngressDependencies,
): void {
  void fastify.register((scope, _options, done) => {
    scope.setErrorHandler((error, request, reply) => {
      const requestId =
        safeRequestId(request.headers['x-request-id']) ?? randomUUID();
      if (
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        error.statusCode === 413
      ) {
        problem(reply, 413, 'webhook.payload_too_large', requestId);
        return;
      }
      problem(reply, 503, 'webhook.unavailable', requestId);
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
      (request, reply) => acceptWebhook(request, reply, dependencies),
    );
    done();
  });
}

async function acceptWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: WebhookIngressDependencies,
): Promise<void> {
  const requestId =
    safeRequestId(request.headers['x-request-id']) ?? randomUUID();
  const body = request.body;
  if (!(body instanceof Uint8Array)) {
    problem(reply, 400, 'webhook.invalid_json', requestId);
    return;
  }
  if (body.byteLength > MAX_BODY) {
    problem(reply, 413, 'webhook.payload_too_large', requestId);
    return;
  }
  const contentType = singleHeader(request, 'content-type');
  if (
    contentType === undefined ||
    !JSON_MEDIA_TYPE.test(contentType) ||
    headerPresent(request, 'content-encoding')
  ) {
    problem(reply, 415, 'webhook.unsupported_media_type', requestId);
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
    authenticationFailed(reply, requestId);
    return;
  }
  const verification = await dependencies.database.resolveVerification(
    sha256(endpointKey),
  );
  if (verification === null || !/^\d{1,16}$/u.test(timestamp)) {
    authenticationFailed(reply, requestId);
    return;
  }
  const seconds = Number(timestamp);
  if (
    !Number.isSafeInteger(seconds) ||
    Math.abs(verification.databaseTime.getTime() / 1000 - seconds) > 300
  ) {
    authenticationFailed(reply, requestId);
    return;
  }

  let current: Uint8Array | undefined;
  let previous: Uint8Array | undefined;
  try {
    current = await openSecret(
      dependencies.encryption,
      verification.currentSecret,
      verification,
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
      );
      previousValid = verifyWebhookSignature({
        secret: previous,
        timestamp,
        signature,
        rawBody: body,
      });
    }
    if (!currentValid && !previousValid) {
      authenticationFailed(reply, requestId);
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(body),
      ) as unknown;
    } catch {
      problem(reply, 400, 'webhook.invalid_json', requestId);
      return;
    }
    const idempotency = optionalIdempotencyKey(request);
    if (idempotency === null) {
      problem(reply, 400, 'request.invalid', requestId);
      return;
    }
    const fingerprint = sha256(
      `${verification.endpointId}\0${sha256(body)}\0application/json`,
    );
    try {
      const traceparent = singleHeader(request, 'traceparent');
      const verifiedSecretVersionId = currentValid
        ? verification.currentSecret.id
        : previousReference?.id;
      if (verifiedSecretVersionId === undefined) {
        authenticationFailed(reply, requestId);
        return;
      }
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
      void reply.code(202).send(result);
    } catch (error) {
      if (error instanceof WebhookDeliveryReplayMismatchError) {
        problem(reply, 409, 'webhook.idempotency_conflict', requestId);
        return;
      }
      if (error instanceof WorkspaceRunQuotaExceededError) {
        reply.header('retry-after', String(error.retryAfterSeconds));
        problem(reply, 429, 'webhook.rate_limited', requestId);
        return;
      }
      if (
        error instanceof WebhookDeliveryIneligibleError ||
        error instanceof WorkspaceRunAdmissionDeniedError
      ) {
        authenticationFailed(reply, requestId);
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
  );
}

function headerPresent(request: FastifyRequest, name: string): boolean {
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

function safeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    ? value
    : undefined;
}

function authenticationFailed(
  reply: FastifyReply,
  requestId: string,
): undefined {
  problem(reply, 401, 'webhook.authentication_failed', requestId);
  return undefined;
}

function problem(
  reply: FastifyReply,
  status: number,
  code: string,
  requestId: string,
): undefined {
  void reply
    .code(status)
    .type('application/problem+json')
    .send({
      type: `urn:pertexo:problem:${code}`,
      title:
        status === 401
          ? 'Webhook authentication failed'
          : 'Webhook request rejected',
      status,
      code,
      requestId,
    });
  return undefined;
}
