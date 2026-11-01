import type {
  RejectedWebhookDelivery,
  WebhookTriggerStore,
  WebhookVerificationReference,
} from '@pertexo/core/triggers';

export type RejectedAttempt = Pick<
  RejectedWebhookDelivery,
  'outcome' | 'signatureCheck' | 'replayCheck'
>;

/**
 * ADR 045: the delivery-log facts for each post-allowance rejection. Each one
 * matches the HTTP status the ingress returns for it.
 */
export const REJECTED_ATTEMPT = Object.freeze({
  staleTimestamp: {
    outcome: 'authentication_failed',
    signatureCheck: 'not_checked',
    replayCheck: 'stale_timestamp',
  },
  signatureMismatch: {
    outcome: 'authentication_failed',
    signatureCheck: 'mismatch',
    replayCheck: 'not_checked',
  },
  invalidRequest: {
    outcome: 'invalid_request',
    signatureCheck: 'verified',
    replayCheck: 'not_checked',
  },
  conflict: {
    outcome: 'conflict',
    signatureCheck: 'verified',
    replayCheck: 'conflict',
  },
  throttled: {
    outcome: 'rate_limited',
    signatureCheck: 'verified',
    replayCheck: 'new',
  },
  ineligible: {
    outcome: 'authentication_failed',
    signatureCheck: 'verified',
    replayCheck: 'new',
  },
  paused: {
    outcome: 'paused',
    signatureCheck: 'verified',
    replayCheck: 'new',
  },
} as const satisfies Readonly<Record<string, RejectedAttempt>>);

/**
 * Records one rejected attempt against its resolved endpoint. The delivery log
 * is diagnostics: a failure to record never changes the response.
 */
export async function recordRejectedAttempt(
  database: Pick<WebhookTriggerStore, 'recordRejectedDelivery'>,
  verification: WebhookVerificationReference,
  body: Uint8Array,
  attempt: RejectedAttempt,
): Promise<void> {
  try {
    await database.recordRejectedDelivery({
      endpoint: {
        workspaceId: verification.workspaceId,
        endpointId: verification.endpointId,
      },
      ...attempt,
      bodyBytes: body.byteLength,
    });
  } catch {
    // Delivery history cannot change webhook acceptance truth.
  }
}
