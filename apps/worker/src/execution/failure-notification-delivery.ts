import { createHash } from 'node:crypto';

import {
  resendApiKeyCredentialSchema,
  slackBotTokenCredentialSchema,
} from '@pertexo/integrations';
import {
  FailureNotificationStateError,
  type FailureNotificationStore,
} from '@pertexo/database';
import type {
  ConnectionEnvelopeEncryption,
  ResendApiResult,
  ResendClient,
  SlackApiResult,
  SlackClient,
} from '@pertexo/integrations/server';
import {
  ConnectionSecretEncryptionError,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '@pertexo/integrations/server';
import type {
  FailureNotificationContextV1,
  FailureNotificationDeliveryResultV1,
} from '@pertexo/workflow-model/failure-notification';

import type { FailureNotificationDeliveryCapability } from './failure-notification-handler.js';

const TIMEOUT_MILLIS = 30_000;

function localFailure(
  error: unknown,
  provider: 'slack' | 'email',
): FailureNotificationDeliveryResultV1 {
  if (error instanceof ConnectionSecretEncryptionError)
    return {
      schemaVersion: 1,
      kind: 'retry',
      safeErrorCode: 'delivery.credential_unavailable',
      possiblyDispatched: false,
    };
  if (error instanceof SecureHttpError) {
    if (error.possiblyDispatched)
      return {
        schemaVersion: 1,
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
      schemaVersion: 1 as const,
      kind: retryable ? ('retry' as const) : ('definite_failure' as const),
      safeErrorCode: retryable
        ? 'delivery.provider_unavailable'
        : 'delivery.provider_rejected',
      possiblyDispatched: false,
    };
  }
  throw error;
}

function settleEmail(
  result: FailureNotificationDeliveryResultV1,
  deliveryUnresolved: boolean,
): FailureNotificationDeliveryResultV1 {
  if (!deliveryUnresolved || result.kind === 'delivered') return result;
  return {
    schemaVersion: 1,
    kind: 'outcome_unknown',
    safeErrorCode: 'delivery.previous_outcome_unresolved',
    possiblyDispatched: true,
  };
}

function render(context: FailureNotificationContextV1): Readonly<{
  subject: string;
  text: string;
}> {
  const subject = `Workflow run ${context.terminalStatus}`;
  const text = [
    subject,
    `Run: ${context.runId}`,
    `Workflow: ${context.workflowId}`,
    `Version: ${context.workflowVersionId}`,
    `Trigger: ${context.triggerType}`,
    `Completed: ${context.completedAt}`,
    `Failure: ${context.primaryFailure.safeErrorCode}`,
    `Node: ${context.primaryFailure.nodeId}`,
    `Failures: ${String(context.totalFailureCount)}`,
  ].join('\n');
  return Object.freeze({ subject, text: text.slice(0, 4_000) });
}

function slackResult(result: SlackApiResult) {
  switch (result.kind) {
    case 'succeeded':
      return {
        schemaVersion: 1 as const,
        kind: 'delivered' as const,
        possiblyDispatched: true,
        providerReference: result.messageTs,
      };
    case 'rejected':
      if (result.error === 'service_unavailable')
        return {
          schemaVersion: 1 as const,
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
          schemaVersion: 1 as const,
          kind: 'outcome_unknown' as const,
          safeErrorCode: 'delivery.provider_ambiguous',
          possiblyDispatched: true,
        };
      return {
        schemaVersion: 1 as const,
        kind: 'definite_failure' as const,
        safeErrorCode: 'delivery.provider_rejected',
        possiblyDispatched: false,
      };
    case 'rate_limited':
      return {
        schemaVersion: 1 as const,
        kind: 'retry' as const,
        safeErrorCode: 'delivery.rate_limited',
        possiblyDispatched: false,
      };
    case 'http_failure':
      return result.status >= 500
        ? {
            schemaVersion: 1 as const,
            kind: 'outcome_unknown' as const,
            safeErrorCode: 'delivery.provider_ambiguous',
            possiblyDispatched: true,
          }
        : {
            schemaVersion: 1 as const,
            kind: 'definite_failure' as const,
            safeErrorCode: 'delivery.provider_rejected',
            possiblyDispatched: false,
          };
    case 'invalid_response':
      return {
        schemaVersion: 1 as const,
        kind: 'outcome_unknown' as const,
        safeErrorCode: 'delivery.provider_ambiguous',
        possiblyDispatched: true,
      };
  }
}

function emailResult(result: ResendApiResult) {
  switch (result.kind) {
    case 'succeeded':
      return {
        schemaVersion: 1 as const,
        kind: 'delivered' as const,
        possiblyDispatched: true,
        providerReference: result.emailId,
      };
    case 'rate_limited':
      return {
        schemaVersion: 1 as const,
        kind: 'retry' as const,
        safeErrorCode: 'delivery.rate_limited',
        possiblyDispatched: false,
      };
    case 'rejected':
      return result.error === 'concurrent_idempotent_requests'
        ? {
            schemaVersion: 1 as const,
            kind: 'retry' as const,
            safeErrorCode: 'delivery.provider_busy',
            possiblyDispatched: false,
          }
        : {
            schemaVersion: 1 as const,
            kind: 'definite_failure' as const,
            safeErrorCode: 'delivery.provider_rejected',
            possiblyDispatched: false,
          };
    case 'http_failure':
      return result.status >= 500
        ? {
            schemaVersion: 1 as const,
            kind: 'retry' as const,
            safeErrorCode: 'delivery.provider_unavailable',
            possiblyDispatched: true,
          }
        : {
            schemaVersion: 1 as const,
            kind: 'definite_failure' as const,
            safeErrorCode: 'delivery.provider_rejected',
            possiblyDispatched: false,
          };
    case 'invalid_response':
      return {
        schemaVersion: 1 as const,
        kind: 'retry' as const,
        safeErrorCode: 'delivery.provider_ambiguous',
        possiblyDispatched: true,
      };
  }
}

export function createProviderFailureNotificationDelivery(
  dependencies: Readonly<{
    store: FailureNotificationStore;
    encryption: Pick<ConnectionEnvelopeEncryption, 'open'>;
    slack: Pick<SlackClient, 'sendMessage'>;
    email: Pick<ResendClient, 'sendNotification'>;
    workerId: string;
  }>,
): FailureNotificationDeliveryCapability {
  return Object.freeze({
    deliver: async (
      input: Parameters<FailureNotificationDeliveryCapability['deliver']>[0],
    ): Promise<FailureNotificationDeliveryResultV1> => {
      let destination: Awaited<
        ReturnType<FailureNotificationStore['loadDestination']>
      >;
      try {
        destination = await dependencies.store.loadDestination({
          workspaceId: input.workspaceId,
          intentId: input.intentId,
          attemptNumber: input.attemptNumber,
          workerId: dependencies.workerId,
          signal: input.signal,
        });
      } catch (error: unknown) {
        if (input.signal.aborted)
          return settleEmail(
            {
              schemaVersion: 1,
              kind: 'retry',
              safeErrorCode: 'delivery.canceled',
              possiblyDispatched: false,
            },
            input.deliveryUnresolved,
          );
        if (error instanceof FailureNotificationStateError)
          return {
            schemaVersion: 1 as const,
            kind: !input.deliveryUnresolved
              ? ('definite_failure' as const)
              : ('outcome_unknown' as const),
            safeErrorCode: !input.deliveryUnresolved
              ? 'delivery.destination_unavailable'
              : 'delivery.identity_changed',
            possiblyDispatched: input.deliveryUnresolved,
          };
        return settleEmail(
          {
            schemaVersion: 1,
            kind: 'retry',
            safeErrorCode: 'delivery.destination_unavailable',
            possiblyDispatched: false,
          },
          input.deliveryUnresolved,
        );
      }
      if (destination.secretVersionId !== input.connectionSecretVersionId)
        return settleEmail(
          {
            schemaVersion: 1,
            kind: 'definite_failure',
            safeErrorCode: 'delivery.identity_changed',
            possiblyDispatched: false,
          },
          input.deliveryUnresolved,
        );
      let bytes: Uint8Array;
      try {
        bytes = await dependencies.encryption.open(
          destination.sealed,
          {
            workspaceId: input.workspaceId,
            connectionId: destination.connectionId,
            secretVersionId: destination.secretVersionId,
          },
          input.signal,
        );
      } catch (error: unknown) {
        if (input.signal.aborted)
          return settleEmail(
            {
              schemaVersion: 1,
              kind: 'retry',
              safeErrorCode: 'delivery.canceled',
              possiblyDispatched: false,
            },
            input.deliveryUnresolved,
          );
        return settleEmail(
          localFailure(error, destination.kind),
          input.deliveryUnresolved,
        );
      }
      const message = render(input.context);
      try {
        let decoded: string;
        try {
          decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          return settleEmail(
            {
              schemaVersion: 1,
              kind: 'definite_failure',
              safeErrorCode: 'delivery.credential_invalid',
              possiblyDispatched: false,
            },
            input.deliveryUnresolved,
          );
        }
        if (destination.kind === 'slack') {
          if (input.sideEffectClass !== 'unsafe')
            throw new Error('Failure notification side-effect class mismatch');
          let credential: ReturnType<
            typeof slackBotTokenCredentialSchema.parse
          >;
          try {
            credential = slackBotTokenCredentialSchema.parse(
              JSON.parse(decoded) as unknown,
            );
          } catch {
            return {
              schemaVersion: 1,
              kind: 'definite_failure',
              safeErrorCode: 'delivery.credential_invalid',
              possiblyDispatched: false,
            };
          }
          try {
            return slackResult(
              await dependencies.slack.sendMessage({
                botToken: credential.botToken,
                channelId: destination.target,
                text: message.text,
                timeoutMillis: TIMEOUT_MILLIS,
                signal: input.signal,
                beforeDispatch: () =>
                  dependencies.store.fenceDispatch({
                    workspaceId: input.workspaceId,
                    intentId: input.intentId,
                    attemptNumber: input.attemptNumber,
                  }),
              }),
            );
          } catch (error: unknown) {
            if (error instanceof FailureNotificationStateError)
              return {
                schemaVersion: 1 as const,
                kind: 'definite_failure' as const,
                safeErrorCode: 'delivery.dispatch_fence_failed',
                possiblyDispatched: false,
              };
            return localFailure(error, 'slack');
          }
        }
        if (input.sideEffectClass !== 'idempotent_with_key')
          throw new Error('Failure notification side-effect class mismatch');
        let credential: ReturnType<typeof resendApiKeyCredentialSchema.parse>;
        try {
          credential = resendApiKeyCredentialSchema.parse(
            JSON.parse(decoded) as unknown,
          );
        } catch {
          return settleEmail(
            {
              schemaVersion: 1,
              kind: 'definite_failure',
              safeErrorCode: 'delivery.credential_invalid',
              possiblyDispatched: false,
            },
            input.deliveryUnresolved,
          );
        }
        const binding = `email:v1:sha256:${createHash('sha256')
          .update(
            JSON.stringify({
              secretVersionId: destination.secretVersionId,
              fromEmail: credential.fromEmail,
              toEmail: destination.target,
              subject: message.subject,
              text: message.text,
              idempotencyKey: input.idempotencyKey,
            }),
          )
          .digest('hex')}`;
        try {
          return settleEmail(
            emailResult(
              await dependencies.email.sendNotification({
                apiKey: credential.apiKey,
                fromEmail: credential.fromEmail,
                toEmail: destination.target,
                subject: message.subject,
                text: message.text,
                idempotencyKey: input.idempotencyKey,
                timeoutMillis: TIMEOUT_MILLIS,
                signal: input.signal,
                beforeDispatch: () =>
                  dependencies.store.fenceDispatch({
                    workspaceId: input.workspaceId,
                    intentId: input.intentId,
                    attemptNumber: input.attemptNumber,
                    deliveryBinding: binding,
                  }),
              }),
            ),
            input.deliveryUnresolved,
          );
        } catch (error: unknown) {
          if (error instanceof FailureNotificationStateError)
            return {
              schemaVersion: 1 as const,
              kind: !input.deliveryUnresolved
                ? ('definite_failure' as const)
                : ('outcome_unknown' as const),
              safeErrorCode: !input.deliveryUnresolved
                ? 'delivery.dispatch_fence_failed'
                : 'delivery.identity_changed',
              possiblyDispatched: input.deliveryUnresolved,
            };
          return settleEmail(
            localFailure(error, 'email'),
            input.deliveryUnresolved,
          );
        }
      } finally {
        bytes.fill(0);
      }
    },
  });
}
