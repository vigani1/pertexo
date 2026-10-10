import { API_PROBLEM_MANIFEST } from '@pertexo/contracts';
import type { ApiProblemCode } from '@pertexo/contracts';
import {
  WebhookDeliveryIneligibleError,
  WebhookDeliveryReplayMismatchError,
  WebhookWorkflowPausedError,
} from '@pertexo/database/triggers';
import {
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '@pertexo/database/runs';
import type { FastifyReply } from 'fastify';
import { CallableInputInvalidError } from '@pertexo/workflow-model';
import { StoredExecutionValueInvalidError } from '@pertexo/database/platform';

import { REJECTED_ATTEMPT, type RejectedAttempt } from './delivery-log.js';
import type { WebhookIngressTelemetry } from './telemetry.js';

/** Maps a refused acceptance to its response and delivery-log fact. */
export async function rejectAcceptance(
  error: unknown,
  reply: FastifyReply,
  requestId: string,
  telemetry: WebhookIngressTelemetry,
  reject: (attempt: RejectedAttempt) => Promise<void>,
): Promise<void> {
  if (
    error instanceof CallableInputInvalidError ||
    error instanceof StoredExecutionValueInvalidError
  ) {
    await reject(REJECTED_ATTEMPT.invalidRequest);
    record(() => {
      telemetry.delivery('invalid_request');
    });
    await problem(reply, 400, 'request.invalid', requestId);
    return;
  }
  if (error instanceof WebhookDeliveryReplayMismatchError) {
    await reject(REJECTED_ATTEMPT.conflict);
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
    await reject(REJECTED_ATTEMPT.throttled);
    record(() => {
      telemetry.delivery('rate_limited');
    });
    reply.header('retry-after', String(error.retryAfterSeconds));
    await problem(reply, 429, 'webhook.rate_limited', requestId);
    return;
  }
  if (error instanceof WebhookWorkflowPausedError) {
    // ADR 056: only a sender that proved the signature learns of the pause.
    await reject(REJECTED_ATTEMPT.paused);
    record(() => {
      telemetry.delivery('paused');
    });
    await problem(reply, 423, 'webhook.workflow_paused', requestId);
    return;
  }
  if (
    error instanceof WebhookDeliveryIneligibleError ||
    error instanceof WorkspaceRunAdmissionDeniedError
  ) {
    await reject(REJECTED_ATTEMPT.ineligible);
    await authenticationFailed(reply, requestId, telemetry);
    return;
  }
  throw error;
}

export async function authenticationFailed(
  reply: FastifyReply,
  requestId: string,
  telemetry: WebhookIngressTelemetry,
): Promise<void> {
  record(() => {
    telemetry.delivery('authentication_failed');
  });
  await problem(reply, 401, 'webhook.authentication_failed', requestId);
}

export function record(operation: () => void): void {
  try {
    operation();
  } catch {
    // Diagnostics cannot change webhook acceptance truth.
  }
}

export async function problem(
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
