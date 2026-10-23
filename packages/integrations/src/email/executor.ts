import {
  type NodeExecutionInvocation,
  type NodeExecutionRuntime,
  type NodeExecutorRegistration,
  NodeExecutorFailure,
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
} from '@pertexo/node-sdk/server';

import { SECURE_HTTP_ERROR_CODE } from '../http/secure.js';
import { inspectSecureHttpError } from '../http/secure-error.js';
import {
  errorNameIs,
  safeInstanceOf,
  safeNumberProperty,
} from '../http/unknown-error.js';
import type { ResendApiResult, ResendClient } from './client.js';
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

export class EmailSendNotificationExecutorError extends NodeExecutorFailure {
  public override readonly name = 'EmailSendNotificationExecutorError';
}

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

function failure(
  kind: 'failed' | 'canceled' | 'retry' | 'outcome_unknown',
  errorKind:
    | 'authentication'
    | 'canceled'
    | 'configuration'
    | 'internal'
    | 'network'
    | 'provider'
    | 'rate_limit'
    | 'timeout',
  {
    possiblyDispatched,
    retryAfterMillis,
  }: Readonly<{
    possiblyDispatched: boolean;
    retryAfterMillis?: number | undefined;
  }>,
) {
  return new EmailSendNotificationExecutorError({
    kind,
    errorKind,
    possiblyDispatched,
    ...(retryAfterMillis === undefined
      ? {}
      : { minimumRetryDelayMillis: Math.min(retryAfterMillis, 60_000) }),
  });
}

function credentialFailure(runtime: NodeExecutionRuntime | undefined) {
  return runtime?.providerDispatchUnresolved !== true
    ? failure('failed', 'authentication', { possiblyDispatched: false })
    : failure('outcome_unknown', 'authentication', {
        possiblyDispatched: true,
      });
}

function dispatchIdentityFailure(
  runtime: NodeExecutionRuntime | undefined,
  errorKind: 'authentication' | 'configuration',
) {
  return runtime?.providerDispatchUnresolved !== true
    ? failure('failed', errorKind, { possiblyDispatched: false })
    : failure('outcome_unknown', errorKind, { possiblyDispatched: true });
}

function classifyResult(
  result: Exclude<ResendApiResult, { kind: 'succeeded' }>,
  runtime: NodeExecutionRuntime,
): never {
  if (runtime.providerDispatchUnresolved === true)
    throw failure('outcome_unknown', 'provider', { possiblyDispatched: true });
  switch (result.kind) {
    case 'rate_limited':
      throw failure('retry', 'rate_limit', {
        possiblyDispatched: false,
        retryAfterMillis: result.retryAfterMillis,
      });
    case 'http_failure':
      if (result.status === 401 || result.status === 403)
        throw failure('failed', 'authentication', {
          possiblyDispatched: false,
        });
      if (result.status === 400 || result.status === 422)
        throw failure('failed', 'provider', { possiblyDispatched: false });
      throw failure('retry', 'provider', { possiblyDispatched: true });
    case 'invalid_response':
      throw failure('retry', 'provider', { possiblyDispatched: true });
    case 'rejected':
      if (result.status === 401 || result.status === 403)
        throw failure('failed', 'authentication', {
          possiblyDispatched: false,
        });
      if (result.status === 400 || result.status === 422)
        throw failure('failed', 'provider', { possiblyDispatched: false });
      if (result.error === 'invalid_idempotent_request')
        throw failure('failed', 'provider', { possiblyDispatched: false });
      throw failure('retry', 'provider', { possiblyDispatched: true });
  }
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

  let resolved;
  try {
    resolved = await connections.resolve({
      connectionId,
      expectedProviderKey: 'email',
      expectedAuthType: 'resend_api_key',
      purpose: 'email.send_notification.execute',
      signal: invocation.signal,
    });
  } catch (error: unknown) {
    if (safeInstanceOf(error, ProviderExecutionRateLimitError)) {
      if (runtime.providerDispatchUnresolved === true)
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
    if (runtime.providerDispatchUnresolved === true)
      throw failure('outcome_unknown', 'provider', {
        possiblyDispatched: true,
      });
    if (invocation.signal.aborted || errorNameIs(error, 'AbortError'))
      throw failure('canceled', 'canceled', { possiblyDispatched: false });
    throw failure('retry', 'provider', { possiblyDispatched: false });
  }
  return withEmailCredential(
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
        if (safeInstanceOf(error, EmailSendNotificationExecutorError))
          throw error;
        const secureError = inspectSecureHttpError(error);
        if (secureError !== undefined) {
          if (
            secureError.code === SECURE_HTTP_ERROR_CODE.dispatchBindingMismatch
          )
            throw dispatchIdentityFailure(runtime, 'configuration');
          if (secureError.code === SECURE_HTTP_ERROR_CODE.connectionFenceFailed)
            throw dispatchIdentityFailure(runtime, 'authentication');
          if (secureError.code === SECURE_HTTP_ERROR_CODE.canceled)
            throw failure('canceled', 'canceled', {
              possiblyDispatched: secureError.possiblyDispatched,
            });
          if (runtime.providerDispatchUnresolved === true)
            throw failure('outcome_unknown', 'provider', {
              possiblyDispatched: true,
            });
          if (
            secureError.code === SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed
          )
            throw failure('retry', 'provider', { possiblyDispatched: false });
          throw failure(
            'retry',
            secureError.code === SECURE_HTTP_ERROR_CODE.timedOut
              ? 'timeout'
              : 'network',
            { possiblyDispatched: secureError.possiblyDispatched },
          );
        }
        throw runtime.providerDispatchUnresolved === true
          ? failure('outcome_unknown', 'provider', { possiblyDispatched: true })
          : failure('retry', 'network', { possiblyDispatched: true });
      }
      if (result.kind !== 'succeeded') classifyResult(result, runtime);
      return emailSendNotificationOutputSchema.parse({
        emailId: result.emailId,
      });
    },
  );
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
