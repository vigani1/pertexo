import { createHash } from 'node:crypto';

import {
  DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  type NodeExecutionInvocation,
  type NodeExecutionRuntime,
  type NodeExecutorRegistration,
  NodeDispatchEvidenceError,
  NodeExecutorFailure,
} from '@pertexo/node-sdk/server';

import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '../http/secure-http.js';
import type { ResendApiResult, ResendClient } from './client.js';
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
  resendApiKeyCredentialSchema,
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

function failure(
  kind: 'failed' | 'canceled' | 'retry' | 'outcome_unknown',
  errorKind:
    | 'authentication'
    | 'canceled'
    | 'configuration'
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
      if (result.error === 'concurrent_idempotent_requests')
        throw failure('retry', 'provider', true);
      throw failure('retry', 'provider', true);
  }
}

async function execute(
  dependencies: EmailSendNotificationExecutorDependencies,
  invocation: NodeExecutionInvocation<unknown, unknown>,
): Promise<EmailSendNotificationOutput> {
  let config;
  let input;
  try {
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
    runtime?.sideEffectClass !== 'idempotent_with_key' ||
    runtime.providerIdempotencyKey === undefined ||
    connectionId === undefined ||
    Object.keys(invocation.connectionRefs).length !== 1
  )
    throw failure('failed', 'configuration', false);
  if (connections?.assertCurrent === undefined)
    throw credentialFailure(runtime);

  let resolved;
  try {
    resolved = await connections.resolve({
      connectionId,
      expectedProviderKey: 'email',
      expectedAuthType: 'resend_api_key',
      purpose: 'email.send_notification.execute',
      signal: invocation.signal,
    });
  } catch {
    throw credentialFailure(runtime);
  }
  try {
    if (
      resolved.connectionId !== connectionId ||
      resolved.providerKey !== 'email' ||
      resolved.authType !== 'resend_api_key'
    )
      throw failure('failed', 'configuration', false);
    let credential;
    try {
      credential = resendApiKeyCredentialSchema.parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(resolved.secret),
        ),
      );
    } catch {
      throw failure('failed', 'authentication', false);
    }
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
        beforeDispatch: async () => {
          try {
            await connections.assertCurrent?.({
              connectionId,
              expectedProviderKey: 'email',
              expectedAuthType: 'resend_api_key',
              secretVersionId: resolved.secretVersionId,
              signal: invocation.signal,
            });
          } catch {
            throw credentialFailure(runtime);
          }
          try {
            await runtime.beforeDispatch({
              connectionFence: {
                connectionId,
                expectedProviderKey: 'email',
                expectedAuthType: 'resend_api_key',
                secretVersionId: resolved.secretVersionId,
              },
              providerDispatchBinding: `email:v1:sha256:${createHash('sha256')
                .update(`email\0${connectionId}\0${resolved.secretVersionId}`)
                .digest('hex')}`,
            });
          } catch (error: unknown) {
            if (error instanceof NodeDispatchEvidenceError) {
              if (error.code === 'provider_dispatch_binding_mismatch')
                throw new SecureHttpError(
                  SECURE_HTTP_ERROR_CODE.dispatchBindingMismatch,
                  'definite_failure',
                  false,
                );
              if (error.code === 'provider_connection_fence_failed')
                throw new SecureHttpError(
                  SECURE_HTTP_ERROR_CODE.connectionFenceFailed,
                  'definite_failure',
                  false,
                );
            }
            throw error;
          }
        },
      });
    } catch (error: unknown) {
      if (error instanceof EmailSendNotificationExecutorError) throw error;
      if (error instanceof SecureHttpError) {
        if (error.code === SECURE_HTTP_ERROR_CODE.dispatchBindingMismatch)
          throw dispatchIdentityFailure(runtime, 'configuration');
        if (error.code === SECURE_HTTP_ERROR_CODE.connectionFenceFailed)
          throw dispatchIdentityFailure(runtime, 'authentication');
        if (error.code === SECURE_HTTP_ERROR_CODE.canceled)
          throw failure('canceled', 'canceled', error.possiblyDispatched);
        if (runtime.providerDispatchUnresolved === true)
          throw failure('outcome_unknown', 'provider', true);
        throw failure(
          'retry',
          error.code === SECURE_HTTP_ERROR_CODE.timedOut
            ? 'timeout'
            : 'network',
          error.possiblyDispatched,
        );
      }
      throw runtime.providerDispatchUnresolved === true
        ? failure('outcome_unknown', 'provider', true)
        : failure('retry', 'network', true);
    }
    if (result.kind !== 'succeeded') classifyResult(result, runtime);
    return emailSendNotificationOutputSchema.parse({ emailId: result.emailId });
  } finally {
    resolved.secret.fill(0);
  }
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
