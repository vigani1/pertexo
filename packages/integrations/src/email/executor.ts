import {
  type NodeConnectionRuntime,
  type NodeExecutionInvocation,
  type NodeExecutionRuntime,
  type NodeExecutorRegistration,
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
} from '@pertexo/node-sdk/server';

import {
  errorNameIs,
  safeInstanceOf,
  safeNumberProperty,
} from '../http/unknown-error.js';
import type { ResendClient } from './client.js';
import {
  classifyResult,
  classifySendError,
  credentialFailure,
  dispatchIdentityFailure,
  failure,
} from './failure.js';
import { prepareAttachments } from './attachments/open.js';
import { sentAttachments } from './attachments/plan.js';
import { createProviderBeforeDispatch } from '../provider-dispatch-fence.js';
import {
  EMAIL_SEND_NOTIFICATION_EXECUTOR,
  RESEND_API_KEY_CONNECTION_SLOT,
} from './definition.js';
import {
  emailSendNotificationConfigSchema,
  emailSendNotificationInputSchema,
  emailSendNotificationOutputSchema,
  resolvedResendApiKeyCredentialSchema,
  type EmailSendNotificationOutput,
} from './validation.js';

export interface EmailSendNotificationExecutorTelemetry {
  measure(
    work: () => Promise<EmailSendNotificationOutput>,
  ): Promise<EmailSendNotificationOutput>;
}

export type EmailSendNotificationExecutorDependencies = Readonly<{
  client: Pick<ResendClient, 'sendNotification'>;
  telemetry?: EmailSendNotificationExecutorTelemetry;
}>;

const NOOP_TELEMETRY: EmailSendNotificationExecutorTelemetry = Object.freeze({
  measure: (work: () => Promise<EmailSendNotificationOutput>) => work(),
});

type ResolvedEmailConnection = Awaited<
  ReturnType<NonNullable<NodeExecutionRuntime['connections']>['resolve']>
>;
type EmailCredential = ReturnType<
  typeof resolvedResendApiKeyCredentialSchema.parse
>;
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

async function withEmailCredential<T>(
  resolved: ResolvedEmailConnection,
  connectionId: string,
  runtime: NodeExecutionRuntime,
  work: (credential: EmailCredential) => Promise<T>,
): Promise<T> {
  try {
    if (
      resolved.connectionId !== connectionId ||
      resolved.providerKey !== 'email' ||
      resolved.authType !== 'resend_api_key'
    )
      throw dispatchIdentityFailure(runtime, 'configuration');
    let credential: EmailCredential;
    try {
      credential = resolvedResendApiKeyCredentialSchema.parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(resolved.secret),
        ),
      );
    } catch {
      throw dispatchIdentityFailure(runtime, 'authentication');
    }
    return await work(credential);
  } finally {
    resolved.secret.fill(0);
  }
}

async function resolveEmailConnection(
  connections: NodeConnectionRuntime,
  connectionId: string,
  runtime: NodeExecutionRuntime,
  signal: AbortSignal,
): Promise<ResolvedEmailConnection> {
  try {
    return await connections.resolve({
      connectionId,
      expectedProviderKey: 'email',
      expectedAuthType: 'resend_api_key',
      purpose: 'email.send_notification.execute',
      signal,
    });
  } catch (error: unknown) {
    if (safeInstanceOf(error, ProviderExecutionRateLimitError)) {
      if (runtime.providerDispatchUnresolved ?? false)
        throw failure('outcome_unknown', 'provider', {
          possiblyDispatched: true,
        });
      const retryAfterSeconds = safeNumberProperty(error, 'retryAfterSeconds');
      if (retryAfterSeconds === undefined)
        throw failure('retry', 'provider', { possiblyDispatched: false });
      throw failure('retry', 'rate_limit', {
        possiblyDispatched: false,
        retryAfterMillis: retryAfterSeconds * 1_000,
      });
    }
    if (safeInstanceOf(error, ProviderCredentialInvalidError))
      throw credentialFailure(runtime);
    if (runtime.providerDispatchUnresolved ?? false)
      throw failure('outcome_unknown', 'provider', {
        possiblyDispatched: true,
      });
    if (signal.aborted || errorNameIs(error, 'AbortError'))
      throw failure('canceled', 'canceled', { possiblyDispatched: false });
    throw failure('retry', 'provider', { possiblyDispatched: false });
  }
}

async function execute(
  dependencies: EmailSendNotificationExecutorDependencies,
  invocation: NodeExecutionInvocation<unknown, unknown>,
): Promise<EmailSendNotificationOutput> {
  let config;
  let input;
  try {
    // Executors are also callable as isolated adapter boundaries, so they
    // retain fail-closed parsing even though createNodeRegistry parses first.
    config = emailSendNotificationConfigSchema.parse(invocation.config);
    input = emailSendNotificationInputSchema.parse(invocation.input);
  } catch {
    throw failure('failed', 'configuration', { possiblyDispatched: false });
  }
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
    return await withEmailCredential(
      resolved,
      connectionId,
      runtime,
      async (credential) => {
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
  return Object.freeze({
    executor: EMAIL_SEND_NOTIFICATION_EXECUTOR,
    execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
      (dependencies.telemetry ?? NOOP_TELEMETRY).measure(() =>
        execute(dependencies, invocation),
      ),
  });
}
