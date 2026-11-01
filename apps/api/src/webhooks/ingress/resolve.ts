import {
  WebhookTestEventError,
  WebhookIngressRateLimitExceededError,
} from '@pertexo/core/triggers';

import type { FastifyReply } from 'fastify';

import { authenticationFailed, problem, record } from './reply.js';

import type {
  WebhookIngressDependencies,
  WebhookAcceptanceOptions,
  PreparedWebhookRequest,
  IngressReferences,
} from './contract.js';
import { sha256 } from './fingerprint.js';

export async function preflightVerification(
  dependencies: Pick<WebhookIngressDependencies, 'database' | 'testEvents'>,
  key: string,
  { testEvent }: Readonly<{ testEvent: boolean }>,
) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(key)) return null;
  if (testEvent)
    return (await dependencies.testEvents?.resolve(sha256(key))) ?? null;
  return dependencies.database.resolveVerification(sha256(key));
}

export async function resolveIngressReference(
  reply: FastifyReply,
  {
    prepared,
    options,
  }: Readonly<{
    prepared: PreparedWebhookRequest;
    options: WebhookAcceptanceOptions;
  }>,
): Promise<IngressReferences | undefined> {
  const { endpointKey, requestId } = prepared;
  const { dependencies, testEvent, telemetry } = options;
  const productionReference = testEvent
    ? null
    : await dependencies.database.resolveVerification(sha256(endpointKey));
  const verification = testEvent
    ? ((await dependencies.testEvents?.resolve(sha256(endpointKey))) ?? null)
    : productionReference;
  if (verification === null) {
    await authenticationFailed(reply, requestId, telemetry);
    return;
  }
  try {
    if (testEvent) await dependencies.testEvents?.consume(verification);
    else
      await dependencies.database.consumeIngressLimit(
        verification.endpointKeyHash,
      );
  } catch (error) {
    if (testEvent && error instanceof WebhookTestEventError) {
      await authenticationFailed(reply, requestId, telemetry);
      return;
    }
    if (error instanceof WebhookIngressRateLimitExceededError) {
      record(() => {
        telemetry.delivery('rate_limited');
      });
      reply.header('retry-after', String(error.retryAfterSeconds));
      await problem(reply, 'webhook.rate_limited', requestId);
      return;
    }
    throw error;
  }
  return { productionReference, verification };
}
