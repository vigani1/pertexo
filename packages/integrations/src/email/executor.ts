import {
  DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  type NodeExecutionInvocation,
  type NodeExecutionRuntime,
  type NodeExecutorRegistration,
  NodeExecutorFailure,
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
} from '@pertexo/node-sdk/server';

import { SECURE_HTTP_ERROR_CODE } from '../http/secure-http.js';
import { inspectSecureHttpError } from '../http/secure-http-error.js';
import {
  errorNameIs,
  safeInstanceOf,
  safeNumberProperty,
} from '../http/unknown-error.js';
import type { ResendApiResult, ResendClient } from './client.js';
import { createProviderBeforeDispatch } from '../provider-dispatch-fence.js';
import {
  EMAIL_SEND_NOTIFICATION_DEFINITION,
  EMAIL_SEND_NOTIFICATION_EXECUTOR,
  EMAIL_SEND_NOTIFICATION_POLICY,
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
  public constructor(
    outcome: ConstructorParameters<typeof NodeExecutorFailure>[0],
    public readonly retryAfterMillis?: number,
  ) {
    super(outcome);
  }
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
  possiblyDispatched: boolean,
  retryAfterMillis?: number,
) {
  return new EmailSendNotificationExecutorError(
    { kind, errorKind, possiblyDispatched },
    retryAfterMillis,
  );
}

function credentialFailure(runtime: NodeExecutionRuntime | undefined) {
  return runtime?.providerDispatchUnresolved !== true
    ? failure('failed', 'authentication', false)
    : failure('outcome_unknown', 'authentication', true);
}

function dispatchIdentityFailure(
  runtime: NodeExecutionRuntime | undefined,
  errorKind: 'authentication' | 'configuration',
) {
  return runtime?.providerDispatchUnresolved !== true
    ? failure('failed', errorKind, false)
    : failure('outcome_unknown', errorKind, true);
}

function classifyResult(
  result: Exclude<ResendApiResult, { kind: 'succeeded' }>,
  runtime: NodeExecutionRuntime,
): never {
  if (runtime.providerDispatchUnresolved === true)
    throw failure('outcome_unknown', 'provider', true);
  switch (result.kind) {
    case 'rate_limited':
      throw failure('retry', 'rate_limit', false, result.retryAfterMillis);
    case 'http_failure':
      if (result.status === 401 || result.status === 403)
        throw failure('failed', 'authentication', false);
      if (result.status === 400 || result.status === 422)
        throw failure('failed', 'provider', false);
      throw failure('retry', 'provider', true);
    case 'invalid_response':
      throw failure('retry', 'provider', true);
    case 'rejected':
      if (result.status === 401 || result.status === 403)
        throw failure('failed', 'authentication', false);
      if (result.status === 400 || result.status === 422)
        throw failure('failed', 'provider', false);
      if (result.error === 'invalid_idempotent_request')
        throw failure('failed', 'provider', false);
      throw failure('retry', 'provider', true);
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
    throw failure('failed', 'configuration', false);
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
    throw failure('failed', 'configuration', false);
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
        throw failure('outcome_unknown', 'provider', true);
      const retryAfterSeconds = safeNumberProperty(error, 'retryAfterSeconds');
      if (retryAfterSeconds === undefined)
        throw failure('retry', 'provider', false);
      throw failure('retry', 'rate_limit', false, retryAfterSeconds * 1_000);
    }
    if (safeInstanceOf(error, ProviderCredentialInvalidError))
      throw credentialFailure(runtime);
    if (runtime.providerDispatchUnresolved === true)
      throw failure('outcome_unknown', 'provider', true);
    if (invocation.signal.aborted || errorNameIs(error, 'AbortError'))
      throw failure('canceled', 'canceled', false);
    throw failure('retry', 'provider', false);
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
            throw failure(
              'canceled',
              'canceled',
              secureError.possiblyDispatched,
            );
          if (runtime.providerDispatchUnresolved === true)
            throw failure('outcome_unknown', 'provider', true);
          if (
            secureError.code === SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed
          )
            throw failure('retry', 'provider', false);
          throw failure(
            'retry',
            secureError.code === SECURE_HTTP_ERROR_CODE.timedOut
              ? 'timeout'
              : 'network',
            secureError.possiblyDispatched,
          );
        }
        throw runtime.providerDispatchUnresolved === true
          ? failure('outcome_unknown', 'provider', true)
          : failure('retry', 'network', true);
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
  lifecycle: NodeExecutorRegistration['lifecycle'] = 'staged',
): NodeExecutorRegistration {
  return Object.freeze({
    abiVersion: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
    definitions: Object.freeze([EMAIL_SEND_NOTIFICATION_DEFINITION]),
    executor: EMAIL_SEND_NOTIFICATION_EXECUTOR,
    lifecycle,
    policyReferences: Object.freeze([EMAIL_SEND_NOTIFICATION_POLICY]),
    execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
      (dependencies.telemetry ?? NOOP_TELEMETRY).measure(() =>
        execute(dependencies, invocation),
      ),
  });
}
