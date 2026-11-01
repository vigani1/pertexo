import { createHash } from 'node:crypto';
import {
  resolvedResendApiKeyCredentialSchema as resendCredentialSchema,
  resolvedSlackBotTokenCredentialSchema as slackCredentialSchema,
} from '@pertexo/integrations';
import { FailureNotificationStateError, type FailureNotificationResolvedDestination, type FailureNotificationStore } from '@pertexo/core/notifications';
import type {
  ConnectionEnvelopeEncryption,
  ResendClient,
  SlackClient,
} from '@pertexo/integrations/server';

import type { FailureNotificationDeliveryResult } from '@pertexo/workflow-model';
import type { FailureNotificationDeliveryCapability } from '../failure-handler.js';
import {
  localFailure,
  settleUnresolvedDelivery,
  slackResult,
  emailResult,
  canceled,
} from './outcomes.js';
import { render } from './content.js';

const TIMEOUT_MILLIS = 30_000;

export type DeliveryInput = Parameters<
  FailureNotificationDeliveryCapability['deliver']
>[0];

export type DeliveryDependencies = Readonly<{
  store: FailureNotificationStore;
  encryption: Pick<ConnectionEnvelopeEncryption, 'open'>;
  slack: Pick<SlackClient, 'sendMessage'>;
  email: Pick<ResendClient, 'sendNotification'>;
  workerId: string;
}>;

type SlackDestination = Extract<
  FailureNotificationResolvedDestination,
  Readonly<{ kind: 'slack' }>
>;

type EmailDestination = Extract<
  FailureNotificationResolvedDestination,
  Readonly<{ kind: 'email' }>
>;

export async function deliverSlack(
  dependencies: DeliveryDependencies,
  destination: SlackDestination,
  input: DeliveryInput,
): Promise<FailureNotificationDeliveryResult> {
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
    if (input.signal.aborted) return canceled(input);
    return settleUnresolvedDelivery(localFailure(error, 'slack'), {
      deliveryUnresolved: input.deliveryUnresolved,
    });
  }

  try {
    let credential: ReturnType<typeof slackCredentialSchema.parse>;
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      credential = slackCredentialSchema.parse(JSON.parse(decoded) as unknown);
    } catch {
      return settleUnresolvedDelivery(
        {
          kind: 'definite_failure',
          safeErrorCode: 'delivery.credential_invalid',
          possiblyDispatched: false,
        },
        { deliveryUnresolved: input.deliveryUnresolved },
      );
    }
    const message = render(input.context);
    try {
      return slackResult(
        await dependencies.slack.sendMessage({
          botToken: credential.botToken,
          channelId: destination.channelId,
          text: message.text,
          timeoutMillis: TIMEOUT_MILLIS,
          signal: input.signal,
          beforeDispatch: () =>
            dependencies.store.fenceDispatch({
              workspaceId: input.workspaceId,
              intentId: input.intentId,
              attemptNumber: input.attemptNumber,
              signal: input.signal,
            }),
        }),
      );
    } catch (error: unknown) {
      if (error instanceof FailureNotificationStateError)
        return {
          kind: 'definite_failure',
          safeErrorCode: 'delivery.dispatch_fence_failed',
          possiblyDispatched: false,
        };
      return localFailure(error, 'slack');
    }
  } finally {
    bytes.fill(0);
  }
}

export async function deliverEmail(
  dependencies: DeliveryDependencies,
  destination: EmailDestination,
  input: DeliveryInput,
): Promise<FailureNotificationDeliveryResult> {
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
    if (input.signal.aborted) return canceled(input);
    return settleUnresolvedDelivery(localFailure(error, 'email'), {
      deliveryUnresolved: input.deliveryUnresolved,
    });
  }

  try {
    let credential: ReturnType<typeof resendCredentialSchema.parse>;
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      credential = resendCredentialSchema.parse(JSON.parse(decoded) as unknown);
    } catch {
      return settleUnresolvedDelivery(
        {
          kind: 'definite_failure',
          safeErrorCode: 'delivery.credential_invalid',
          possiblyDispatched: false,
        },
        { deliveryUnresolved: input.deliveryUnresolved },
      );
    }
    const message = render(input.context);
    const binding = `email:sha256:${createHash('sha256')
      .update(
        JSON.stringify({
          secretVersionId: destination.secretVersionId,
          fromEmail: credential.fromEmail,
          toEmail: destination.toEmail,
          subject: message.subject,
          text: message.text,
          idempotencyKey: input.idempotencyKey,
        }),
      )
      .digest('hex')}`;
    try {
      return settleUnresolvedDelivery(
        emailResult(
          await dependencies.email.sendNotification({
            apiKey: credential.apiKey,
            fromEmail: credential.fromEmail,
            toEmail: destination.toEmail,
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
                signal: input.signal,
              }),
          }),
        ),
        { deliveryUnresolved: input.deliveryUnresolved },
      );
    } catch (error: unknown) {
      if (error instanceof FailureNotificationStateError)
        return input.deliveryUnresolved
          ? {
              kind: 'outcome_unknown',
              safeErrorCode: 'delivery.identity_changed',
              possiblyDispatched: true,
            }
          : {
              kind: 'definite_failure',
              safeErrorCode: 'delivery.dispatch_fence_failed',
              possiblyDispatched: false,
            };
      return settleUnresolvedDelivery(localFailure(error, 'email'), {
        deliveryUnresolved: input.deliveryUnresolved,
      });
    }
  } finally {
    bytes.fill(0);
  }
}
