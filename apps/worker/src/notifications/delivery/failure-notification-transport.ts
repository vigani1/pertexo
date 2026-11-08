import { smtpCredentialSchema } from '@pertexo/integrations';
import { z } from 'zod';
import type { SmtpEmailClient } from '@pertexo/integrations/server';
import { createHash } from 'node:crypto';
import {
  resolvedResendApiKeyCredentialSchema as resendCredentialSchema,
  resolvedSlackBotTokenCredentialSchema as slackCredentialSchema,
} from '@pertexo/integrations';
import {
  FailureNotificationStateError,
  type FailureNotificationResolvedDestination,
  type FailureNotificationStore,
} from '@pertexo/core/notifications';
import type { ConnectionEnvelopeEncryption } from '@pertexo/secrets/server';
import type { ResendClient, SlackClient } from '@pertexo/integrations/server';

import type { FailureNotificationDeliveryResult } from '@pertexo/workflow-model';
import type { FailureNotificationDeliveryCapability } from '../failure-handler.js';
import {
  localFailure,
  settleUnresolvedDelivery,
  slackResult,
  emailResult,
  canceled,
} from './failure-notification-outcomes.js';
import { render } from './failure-notification-content.js';

const TIMEOUT_MILLIS = 30_000;

export type DeliveryInput = Parameters<
  FailureNotificationDeliveryCapability['deliver']
>[0];

export type DeliveryDependencies = Readonly<{
  store: FailureNotificationStore;
  encryption: Pick<ConnectionEnvelopeEncryption, 'open'>;
  slack: Pick<SlackClient, 'sendMessage'>;
  email: Pick<ResendClient, 'sendNotification'>;
  smtp?: SmtpEmailClient;
  workerId: string;
  publicWebOrigin: string;
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
    const message = render(input.context, {
      workflowName: destination.workflowName,
      runUrl: new URL(
        `/w/${input.workspaceId}/runs/${input.context.runId}`,
        dependencies.publicWebOrigin,
      ).toString(),
      kind: destination.kind,
    });
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
              destinationIdentity: destination,
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
    const emailCredentialSchema = z.discriminatedUnion('type', [
      resendCredentialSchema,
      smtpCredentialSchema,
    ]);
    let credential: z.output<typeof emailCredentialSchema>;
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      credential = emailCredentialSchema.parse(JSON.parse(decoded) as unknown);
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
    const message = render(input.context, {
      workflowName: destination.workflowName,
      runUrl: new URL(
        `/w/${input.workspaceId}/runs/${input.context.runId}`,
        dependencies.publicWebOrigin,
      ).toString(),
      kind: destination.kind,
    });
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
    if (credential.type === 'smtp')
      return await deliverSmtp(dependencies, destination, input, {
        credential,
        message,
        binding,
      });
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
                destinationIdentity: destination,
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

async function deliverSmtp(
  dependencies: DeliveryDependencies,
  destination: EmailDestination,
  input: DeliveryInput,
  {
    credential,
    message,
    binding,
  }: Readonly<{
    credential: z.output<typeof smtpCredentialSchema>;
    message: Readonly<{ subject: string; text: string }>;
    binding: string;
  }>,
): Promise<FailureNotificationDeliveryResult> {
  if (input.deliveryUnresolved)
    return {
      kind: 'outcome_unknown',
      safeErrorCode: 'delivery.smtp_unconfirmed',
      possiblyDispatched: true,
    };
  if (dependencies.smtp === undefined)
    return {
      kind: 'definite_failure',
      safeErrorCode: 'delivery.smtp_unavailable',
      possiblyDispatched: false,
    };
  const result = await dependencies.smtp.sendNotification(credential, {
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
        destinationIdentity: destination,
        deliveryBinding: binding,
        signal: input.signal,
      }),
  });
  if (result.kind === 'submitted')
    return { kind: 'delivered', possiblyDispatched: true };
  const safeErrorCode = `delivery.smtp_${result.failure.category}`;
  if (result.kind === 'unknown')
    return {
      kind: 'outcome_unknown',
      safeErrorCode,
      possiblyDispatched: true,
    };
  if (result.kind === 'retryable')
    return { kind: 'retry', safeErrorCode, possiblyDispatched: false };
  return {
    kind: 'definite_failure',
    safeErrorCode,
    possiblyDispatched: false,
  };
}
