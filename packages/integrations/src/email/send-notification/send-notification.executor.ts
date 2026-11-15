import { smtpCredentialSchema } from '@pertexo/contracts';
import { z } from 'zod';
import { requireSmtpAccepted, type SmtpEmailClient } from '../smtp.js';
import type {
  NodeConnectionRuntime,
  NodeExecutionInvocation,
  NodeExecutionRuntime,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import type { ResendClient } from '../client.js';
import {
  classifyResult,
  classifySendError,
  credentialFailure,
  dispatchIdentityFailure,
  failure,
} from './send-notification.errors.js';
import { prepareAttachments } from '../attachments/open.js';
import { sentAttachments } from '../attachments/plan.js';
import { createProviderBeforeDispatch } from '../../providers/provider-dispatch-fence.js';
import { connectionLookupFailure } from '../../providers/provider.errors.js';
import {
  EMAIL_SEND_NOTIFICATION_EXECUTOR,
  RESEND_API_KEY_CONNECTION_SLOT,
} from './send-notification.definition.js';
import {
  emailSendNotificationOutputSchema,
  resolvedResendApiKeyCredentialSchema,
  type EmailSendNotificationConfig,
  type EmailSendNotificationInput,
  type EmailSendNotificationOutput,
} from './send-notification.schemas.js';
import {
  withProviderCredential,
  type ResolvedProviderConnection,
} from '@pertexo/node-sdk/server';
import {
  registerProviderExecutor,
  type ExecutorTelemetry,
} from '../../providers/provider-executor.js';

export type EmailSendNotificationExecutorDependencies = Readonly<{
  client: Pick<ResendClient, 'sendNotification'>;
  smtp?: SmtpEmailClient;
  telemetry?: ExecutorTelemetry<EmailSendNotificationOutput>;
}>;

const emailCredentialSchema = z.discriminatedUnion('type', [
  resolvedResendApiKeyCredentialSchema,
  smtpCredentialSchema,
]);
const EMAIL_AUTH_TYPES = ['resend_api_key', 'smtp'] as const;
type IdempotentEmailRuntime = NodeExecutionRuntime &
  Readonly<{ providerIdempotencyKey: string }>;

function hasIdempotentEmailDispatchPolicy(
  runtime: NodeExecutionRuntime | undefined,
): runtime is IdempotentEmailRuntime {
  return (
    runtime?.sideEffectClass === 'idempotent_with_key' &&
    runtime.providerIdempotencyKey !== undefined
  );
}

async function resolveEmailConnection(
  connections: NodeConnectionRuntime,
  connectionId: string,
  runtime: NodeExecutionRuntime,
  signal: AbortSignal,
): Promise<ResolvedProviderConnection> {
  try {
    return await connections.resolve({
      connectionId,
      expectedProviderKey: 'email',
      expectedAuthType: 'resend_api_key',
      purpose: 'email.send_notification.execute',
      signal,
    });
  } catch (error: unknown) {
    throw connectionLookupFailure(error, { failure, runtime, signal });
  }
}

async function execute(
  dependencies: EmailSendNotificationExecutorDependencies,
  invocation: NodeExecutionInvocation<unknown, unknown>,
): Promise<EmailSendNotificationOutput> {
  // The registry has already parsed both against the definition's schemas.
  const config = invocation.config as EmailSendNotificationConfig;
  const input = invocation.input as EmailSendNotificationInput;
  const runtime = invocation.runtime;
  const connections = runtime?.connections;
  const connectionId =
    invocation.connectionRefs[RESEND_API_KEY_CONNECTION_SLOT];
  if (
    !hasIdempotentEmailDispatchPolicy(runtime) ||
    connectionId === undefined ||
    Object.keys(invocation.connectionRefs).length !== 1
  )
    throw failure('failed', 'configuration', { possiblyDispatched: false });
  if (connections?.assertCurrent === undefined)
    throw credentialFailure(runtime);
  const assertCurrent = connections.assertCurrent;
  const attachments = await prepareAttachments(
    input.attachments,
    runtime,
    invocation.signal,
  );
  try {
    const resolved = await resolveEmailConnection(
      connections,
      connectionId,
      runtime,
      invocation.signal,
    );
    return await withProviderCredential(
      resolved,
      {
        connectionId,
        providerKey: 'email',
        authTypes: EMAIL_AUTH_TYPES,
        schema: emailCredentialSchema,
        refuse: (reason) => dispatchIdentityFailure(runtime, reason),
      },
      async (credential) => {
        if (credential.type === 'smtp') {
          if (runtime.providerDispatchUnresolved ?? false)
            throw failure('outcome_unknown', 'provider', {
              possiblyDispatched: true,
            });
          if (dependencies.smtp === undefined)
            throw dispatchIdentityFailure(runtime, 'configuration');
          const result = await dependencies.smtp.sendNotification(credential, {
            fromEmail: credential.fromEmail,
            toEmail: input.toEmail,
            subject: input.subject,
            text: input.text,
            ...(attachments.files.length === 0
              ? {}
              : {
                  attachments: {
                    files: attachments.files,
                    spool: attachments.spool,
                  },
                }),
            idempotencyKey: runtime.providerIdempotencyKey,
            timeoutMillis: config.timeoutMillis,
            signal: invocation.signal,
            beforeDispatch: createProviderBeforeDispatch({
              assertCurrent,
              connectionId,
              expectedProviderKey: 'email',
              expectedAuthType: 'smtp',
              secretVersionId: resolved.secretVersionId,
              signal: invocation.signal,
              runtime,
            }),
          });
          requireSmtpAccepted(result, runtime);
          return emailSendNotificationOutputSchema.parse({
            emailId: runtime.attemptId,
            ...sentAttachments(attachments.planned),
          });
        }
        let result;
        try {
          result = await dependencies.client.sendNotification({
            apiKey: credential.apiKey,
            fromEmail: credential.fromEmail,
            toEmail: input.toEmail,
            subject: input.subject,
            text: input.text,
            ...(attachments.files.length === 0
              ? {}
              : {
                  attachments: {
                    files: attachments.files,
                    spool: attachments.spool,
                  },
                }),
            idempotencyKey: runtime.providerIdempotencyKey,
            sensitiveValues:
              invocation.runtime?.callbacks?.sensitiveValues() ?? [],
            timeoutMillis: config.timeoutMillis,
            signal: invocation.signal,
            beforeDispatch: createProviderBeforeDispatch({
              assertCurrent,
              connectionId,
              expectedProviderKey: 'email',
              expectedAuthType: 'resend_api_key',
              secretVersionId: resolved.secretVersionId,
              signal: invocation.signal,
              runtime,
            }),
          });
        } catch (error: unknown) {
          throw classifySendError(error, runtime);
        }
        if (result.kind !== 'succeeded') classifyResult(result, runtime);
        return emailSendNotificationOutputSchema.parse({
          emailId: result.emailId,
          ...sentAttachments(attachments.planned),
        });
      },
    );
  } finally {
    await attachments.release();
  }
}

export function createEmailSendNotificationExecutorRegistration(
  dependencies: EmailSendNotificationExecutorDependencies,
): NodeExecutorRegistration {
  return registerProviderExecutor(
    EMAIL_SEND_NOTIFICATION_EXECUTOR,
    dependencies.telemetry,
    (invocation) => execute(dependencies, invocation),
  );
}
