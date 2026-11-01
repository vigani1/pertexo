import {
  headerPresent,
  singleHeader,
  WEBHOOK_FRESHNESS_ALLOWANCE_SECONDS,
} from '../requests/headers.js';

import { verifyWebhookHeaderSecret } from '../authentication/header-secret.js';
import {
  allowWebhookOrigin,
  webhookOriginAllowed,
} from '../authentication/cors.js';

import type {
  TestEventReference,
  WebhookVerificationReference,
} from '@pertexo/core/triggers';

import {
  verifyWebhookSignature,
  type WebhookTriggerEnvelopeEncryption,
} from '@pertexo/integrations/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { REJECTED_ATTEMPT } from '../management/delivery-log.js';
import { authenticationFailed, problem, record } from './reply.js';

import type {
  WebhookAcceptanceOptions,
  PreparedWebhookRequest,
  IngressReferences,
  IngressRejectionRecorder,
} from './contract.js';

async function verifyWebhookSecrets(
  encryption: WebhookTriggerEnvelopeEncryption,
  verification: TestEventReference,
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
  verification: Pick<WebhookVerificationReference, 'workspaceId'>,
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
      triggerId: sealed.triggerId,
      secretVersionId: sealed.id,
    },
    signal,
  );
}

export async function authenticateIngressRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  {
    prepared,
    references,
    options,
    reject,
  }: Readonly<{
    prepared: PreparedWebhookRequest;
    references: IngressReferences;
    options: WebhookAcceptanceOptions;
    reject: IngressRejectionRecorder;
  }>,
): Promise<string | undefined> {
  const { method, dependencies, telemetry, encryptionSignal } = options;
  const { requestId, body, timestamp, signature } = prepared;
  const { verification } = references;
  if (method === 'GET' && verification.authentication.mode === 'signed') {
    await reject(REJECTED_ATTEMPT.invalidRequest);
    record(() => {
      telemetry.delivery('invalid_request');
    });
    reply.header('allow', 'POST');
    await problem(reply, 'webhook.method_not_allowed', requestId);
    return;
  }
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
  return verifiedSecretVersionId;
}
