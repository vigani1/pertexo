import type {
  ResendApiResult,
  SlackApiResult,
} from '@pertexo/integrations/server';
import {
  ConnectionSecretEncryptionError,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '@pertexo/integrations/server';
import type { FailureNotificationDeliveryResult } from '@pertexo/workflow-model';

import type { DeliveryInput } from './transport.js';

export function localFailure(
  error: unknown,
  provider: 'slack' | 'email',
): FailureNotificationDeliveryResult {
  if (error instanceof ConnectionSecretEncryptionError)
    return {
      kind: 'retry',
      safeErrorCode: 'delivery.credential_unavailable',
      possiblyDispatched: false,
    };
  if (error instanceof SecureHttpError) {
    if (error.possiblyDispatched)
      return {
        kind: provider === 'slack' ? 'outcome_unknown' : 'retry',
        safeErrorCode: 'delivery.provider_ambiguous',
        possiblyDispatched: true,
      };
    const retryable = (
      [
        SECURE_HTTP_ERROR_CODE.canceled,
        SECURE_HTTP_ERROR_CODE.dnsFailed,
        SECURE_HTTP_ERROR_CODE.networkFailed,
        SECURE_HTTP_ERROR_CODE.timedOut,
        SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed,
      ] as readonly string[]
    ).includes(error.code);
    return {
      kind: retryable ? ('retry' as const) : ('definite_failure' as const),
      safeErrorCode: retryable
        ? 'delivery.provider_unavailable'
        : 'delivery.provider_rejected',
      possiblyDispatched: false,
    };
  }
  throw error;
}

export function settleUnresolvedDelivery(
  result: FailureNotificationDeliveryResult,
  { deliveryUnresolved }: Readonly<{ deliveryUnresolved: boolean }>,
): FailureNotificationDeliveryResult {
  if (!deliveryUnresolved || result.kind === 'delivered') return result;
  return {
    kind: 'outcome_unknown',
    safeErrorCode: 'delivery.previous_outcome_unresolved',
    possiblyDispatched: true,
  };
}

export function slackResult(
  result: SlackApiResult,
): FailureNotificationDeliveryResult {
  switch (result.kind) {
    case 'succeeded':
      return {
        kind: 'delivered' as const,
        possiblyDispatched: true,
        providerReference: result.messageTs,
      };
    case 'rejected':
      if (result.error === 'service_unavailable')
        return {
          kind: 'retry' as const,
          safeErrorCode: 'delivery.provider_unavailable',
          possiblyDispatched: false,
        };
      if (
        ![
          'channel_not_found',
          'invalid_auth',
          'is_archived',
          'missing_scope',
          'not_authed',
          'not_in_channel',
          'no_permission',
        ].includes(result.error)
      )
        return {
          kind: 'outcome_unknown' as const,
          safeErrorCode: 'delivery.provider_ambiguous',
          possiblyDispatched: true,
        };
      return {
        kind: 'definite_failure' as const,
        safeErrorCode: 'delivery.provider_rejected',
        possiblyDispatched: false,
      };
    case 'rate_limited':
      return {
        kind: 'retry' as const,
        safeErrorCode: 'delivery.rate_limited',
        possiblyDispatched: false,
      };
    case 'http_failure':
      return result.status >= 500
        ? {
            kind: 'outcome_unknown' as const,
            safeErrorCode: 'delivery.provider_ambiguous',
            possiblyDispatched: true,
          }
        : {
            kind: 'definite_failure' as const,
            safeErrorCode: 'delivery.provider_rejected',
            possiblyDispatched: false,
          };
    case 'invalid_response':
      return {
        kind: 'outcome_unknown' as const,
        safeErrorCode: 'delivery.provider_ambiguous',
        possiblyDispatched: true,
      };
  }
}

export function emailResult(
  result: ResendApiResult,
): FailureNotificationDeliveryResult {
  switch (result.kind) {
    case 'succeeded':
      return {
        kind: 'delivered' as const,
        possiblyDispatched: true,
        providerReference: result.emailId,
      };
    case 'rate_limited':
      return {
        kind: 'retry' as const,
        safeErrorCode: 'delivery.rate_limited',
        possiblyDispatched: false,
      };
    case 'rejected':
      return result.error === 'concurrent_idempotent_requests'
        ? {
            kind: 'retry' as const,
            safeErrorCode: 'delivery.provider_busy',
            possiblyDispatched: false,
          }
        : {
            kind: 'definite_failure' as const,
            safeErrorCode: 'delivery.provider_rejected',
            possiblyDispatched: false,
          };
    case 'http_failure':
      return result.status >= 500
        ? {
            kind: 'retry' as const,
            safeErrorCode: 'delivery.provider_unavailable',
            possiblyDispatched: true,
          }
        : {
            kind: 'definite_failure' as const,
            safeErrorCode: 'delivery.provider_rejected',
            possiblyDispatched: false,
          };
    case 'invalid_response':
      return {
        kind: 'retry' as const,
        safeErrorCode: 'delivery.provider_ambiguous',
        possiblyDispatched: true,
      };
  }
}

export function canceled(
  input: DeliveryInput,
): FailureNotificationDeliveryResult {
  return settleUnresolvedDelivery(
    {
      kind: 'retry',
      safeErrorCode: 'delivery.canceled',
      possiblyDispatched: false,
    },
    { deliveryUnresolved: input.deliveryUnresolved },
  );
}
