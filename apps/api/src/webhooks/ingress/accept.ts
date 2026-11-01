import { webhookRunInput } from '@pertexo/nodes-core';
import { asksSenderToRetry } from '@pertexo/workflow-model';

import { replyToAcceptedWebhook } from '../responses/reply.js';

import {
  WebhookTestEventError,
  type TestEventReference,
  type WebhookVerificationReference,
} from '@pertexo/database/triggers';

import type { FastifyReply, FastifyRequest } from 'fastify';
import { REJECTED_ATTEMPT } from '../management/delivery-log.js';
import {
  authenticationFailed,
  problem,
  record,
  rejectAcceptance,
} from './reply.js';
import type { WebhookIngressTelemetry } from './telemetry.js';

import { rawWebhookQuery } from '../requests/details.js';
import type {
  WebhookAcceptanceOptions,
  PreparedWebhookRequest,
  IngressRejectionRecorder,
  WebhookRequestData,
} from './contract.js';
import { optionalIdempotencyKey, sha256 } from './fingerprint.js';

/** Pending events leave on their own schedule, so this only paces the sender. */
const COORDINATION_FULL_RETRY_SECONDS = 60;

function diagnosticTraceparent(
  telemetry: WebhookIngressTelemetry,
): string | undefined {
  try {
    return telemetry.traceparent();
  } catch {
    return undefined;
  }
}

export async function captureIngressTestEvent(
  reply: FastifyReply,
  {
    options,
    verification,
    requestId,
    requestData,
  }: Readonly<{
    options: WebhookAcceptanceOptions;
    verification: TestEventReference;
    requestId: string;
    requestData: WebhookRequestData;
  }>,
): Promise<void> {
  const { dependencies, telemetry } = options;
  try {
    if (
      await dependencies.testEvents?.capture(
        verification,
        webhookRunInput(verification.runInputMode, requestData),
      )
    ) {
      await reply
        .header('cache-control', 'no-store')
        .code(202)
        .send({ captured: true });
    } else await authenticationFailed(reply, requestId, telemetry);
  } catch (error) {
    if (
      error instanceof WebhookTestEventError &&
      error.reason === 'value_invalid'
    )
      await problem(reply, 'webhook.payload_too_large', requestId);
    else throw error;
  }
  return;
}

export async function admitIngressDelivery(
  request: FastifyRequest,
  reply: FastifyReply,
  {
    options,
    prepared,
    references,
    verifiedSecretVersionId,
    requestData,
    reject,
  }: Readonly<{
    options: WebhookAcceptanceOptions;
    prepared: PreparedWebhookRequest;
    references: Readonly<{
      verification: TestEventReference;
      productionReference: WebhookVerificationReference;
    }>;
    verifiedSecretVersionId: string;
    requestData: WebhookRequestData;
    reject: IngressRejectionRecorder;
  }>,
): Promise<void> {
  const { method, dependencies, telemetry, encryptionSignal, responseWaiter } =
    options;
  const { requestId, body, mediaType } = prepared;
  const { verification, productionReference } = references;
  const idempotency = optionalIdempotencyKey(request);
  if (idempotency === null) {
    await reject(REJECTED_ATTEMPT.invalidRequest);
    record(() => {
      telemetry.delivery('invalid_request');
    });
    await problem(reply, 'request.invalid', requestId);
    return;
  }
  const query = rawWebhookQuery(request);
  const fingerprint = sha256(
    method === 'GET'
      ? `${verification.endpointId}\0GET\0${sha256(query)}`
      : `${verification.endpointId}\0${sha256(body)}\0${mediaType}${query === '' ? '' : `\0${sha256(query)}`}`,
  );
  try {
    const traceparent = diagnosticTraceparent(telemetry);
    encryptionSignal.throwIfAborted();
    const result = await dependencies.database.acceptVerifiedDelivery({
      verification: productionReference,
      verifiedSecretVersionId,
      requestFingerprint: fingerprint,
      bodyBytes: body.byteLength,
      ...(idempotency === undefined
        ? {}
        : { idempotencyKeyHash: sha256(idempotency) }),
      runInput: webhookRunInput(productionReference.runInputMode, requestData),
      signal: encryptionSignal,
      checkpointFactory: dependencies.checkpointFactory,
      ...(traceparent === undefined ? {} : { traceparent }),
    });
    if ('coordinated' in result) {
      if (asksSenderToRetry(result)) {
        record(() => {
          telemetry.delivery('rate_limited');
        });
        reply.header('retry-after', String(COORDINATION_FULL_RETRY_SECONDS));
        await problem(reply, 'webhook.rate_limited', requestId);
        return;
      }
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
    await replyToAcceptedWebhook(request, reply, {
      workspaceId: verification.workspaceId,
      accepted: result,
      waiter: responseWaiter,
      telemetry: telemetry,
      logger: dependencies.logger,
    });
  } catch (error) {
    await rejectAcceptance(error, reply, {
      requestId: requestId,
      workspaceId: verification.workspaceId,
      signal: encryptionSignal,
      telemetry: telemetry,
      logger: dependencies.logger,
      reject: reject,
    });
  }
}
