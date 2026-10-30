import {
  type NodeExecutionInvocation,
  type NodeExecutionRuntime,
  type NodeExecutorRegistration,
  NodeExecutorFailure,
} from '@pertexo/node-sdk/server';

import { SECURE_HTTP_ERROR_CODE } from '../http/secure.js';
import { inspectSecureHttpError } from '../http/secure-error.js';
import { safeInstanceOf } from '../http/unknown-error.js';
import type { SlackApiResult, SlackClient } from './client.js';
import { classifySlackConnectionHealth } from './connection-health.js';
import {
  SLACK_BOT_TOKEN_CONNECTION_SLOT,
  SLACK_SEND_MESSAGE_EXECUTOR,
} from './definition.js';
import {
  resolvedSlackBotTokenCredentialSchema,
  slackSendMessageOutputSchema,
  type SlackSendMessageConfig,
  type SlackSendMessageInput,
  type SlackSendMessageOutput,
} from './validation.js';
import { createProviderBeforeDispatch } from '../provider-dispatch-fence.js';
import {
  connectionLookupFailure,
  providerFailure,
} from '../providers/failure.js';

const AUTH_ERRORS = new Set([
  'account_inactive',
  'invalid_auth',
  'not_authed',
  'token_revoked',
]);
const DEFINITE_ERRORS = new Set([
  ...AUTH_ERRORS,
  'channel_not_found',
  'is_archived',
  'missing_scope',
  'msg_too_long',
  'no_permission',
  'no_text',
  'not_in_channel',
]);
const RETRYABLE_ERRORS = new Set(['service_unavailable']);

type ResolvedSlackConnection = Awaited<
  ReturnType<NonNullable<NodeExecutionRuntime['connections']>['resolve']>
>;
type SlackCredential = ReturnType<
  typeof resolvedSlackBotTokenCredentialSchema.parse
>;

export class SlackSendMessageExecutorError extends NodeExecutorFailure {
  public override readonly name = 'SlackSendMessageExecutorError';
}

export interface SlackSendMessageExecutorTelemetry {
  measure(
    work: () => Promise<SlackSendMessageOutput>,
  ): Promise<SlackSendMessageOutput>;
}

export type SlackSendMessageExecutorDependencies = Readonly<{
  client: Pick<SlackClient, 'sendMessage'>;
  telemetry?: SlackSendMessageExecutorTelemetry;
}>;

const NOOP_TELEMETRY: SlackSendMessageExecutorTelemetry = Object.freeze({
  measure: (work: () => Promise<SlackSendMessageOutput>) => work(),
});

const failure = providerFailure(SlackSendMessageExecutorError);

function classifyResult(
  result: Exclude<SlackApiResult, { kind: 'succeeded' }>,
): never {
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
      throw failure('outcome_unknown', 'provider', {
        possiblyDispatched: true,
      });
    case 'invalid_response':
      throw failure('outcome_unknown', 'provider', {
        possiblyDispatched: true,
      });
    case 'rejected':
      if (AUTH_ERRORS.has(result.error))
        throw failure('failed', 'authentication', {
          possiblyDispatched: false,
        });
      if (DEFINITE_ERRORS.has(result.error))
        throw failure('failed', 'provider', { possiblyDispatched: false });
      if (RETRYABLE_ERRORS.has(result.error))
        throw failure('retry', 'provider', { possiblyDispatched: false });
      throw failure('outcome_unknown', 'provider', {
        possiblyDispatched: true,
      });
  }
}

async function withSlackCredential<T>(
  resolved: ResolvedSlackConnection,
  connectionId: string,
  work: (credential: SlackCredential) => Promise<T>,
): Promise<T> {
  try {
    if (
      resolved.connectionId !== connectionId ||
      resolved.providerKey !== 'slack' ||
      resolved.authType !== 'slack_bot_token'
    )
      throw failure('failed', 'configuration', { possiblyDispatched: false });
    let credential: SlackCredential;
    try {
      credential = resolvedSlackBotTokenCredentialSchema.parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(resolved.secret),
        ),
      );
    } catch {
      throw failure('failed', 'authentication', { possiblyDispatched: false });
    }
    return await work(credential);
  } finally {
    resolved.secret.fill(0);
  }
}

async function execute(
  dependencies: SlackSendMessageExecutorDependencies,
  invocation: NodeExecutionInvocation<unknown, unknown>,
): Promise<SlackSendMessageOutput> {
  // The registry has already parsed both against the definition's schemas.
  const config = invocation.config as SlackSendMessageConfig;
  const input = invocation.input as SlackSendMessageInput;
  const runtime = invocation.runtime;
  const connections = runtime?.connections;
  const connectionId =
    invocation.connectionRefs[SLACK_BOT_TOKEN_CONNECTION_SLOT];
  const invalidDispatchRuntime =
    runtime === undefined ||
    connections?.assertCurrent === undefined ||
    runtime.sideEffectClass !== 'unsafe' ||
    runtime.providerIdempotencyKey !== undefined ||
    connectionId === undefined ||
    Object.keys(invocation.connectionRefs).length !== 1;
  if (invalidDispatchRuntime)
    throw failure('failed', 'configuration', { possiblyDispatched: false });
  const assertCurrent = connections.assertCurrent;

  let resolved;
  try {
    resolved = await connections.resolve({
      connectionId,
      expectedProviderKey: 'slack',
      expectedAuthType: 'slack_bot_token',
      purpose: 'slack.send_message.execute',
      signal: invocation.signal,
    });
  } catch (error: unknown) {
    throw connectionLookupFailure(error, {
      failure,
      runtime,
      signal: invocation.signal,
    });
  }
  return withSlackCredential(resolved, connectionId, async (credential) => {
    let result;
    try {
      result = await dependencies.client.sendMessage({
        botToken: credential.botToken,
        channelId: input.channelId,
        text: input.text,
        sensitiveValues: invocation.runtime?.callbacks?.sensitiveValues() ?? [],
        timeoutMillis: config.timeoutMillis,
        signal: invocation.signal,
        beforeDispatch: createProviderBeforeDispatch({
          assertCurrent,
          connectionId,
          expectedProviderKey: 'slack',
          expectedAuthType: 'slack_bot_token',
          secretVersionId: resolved.secretVersionId,
          signal: invocation.signal,
          runtime,
        }),
      });
    } catch (error: unknown) {
      rethrowSlackDispatchError(error, runtime);
    }
    if (result.kind !== 'succeeded') {
      const observation = classifySlackConnectionHealth(result);
      if (observation !== undefined)
        runtime.observeConnectionHealth?.(observation);
      classifyResult(result);
    }
    if (result.channelId !== input.channelId)
      throw failure('outcome_unknown', 'provider', {
        possiblyDispatched: true,
      });
    const output = slackSendMessageOutputSchema.parse({
      channelId: result.channelId,
      messageTs: result.messageTs,
    });
    const observation = classifySlackConnectionHealth(result);
    if (observation !== undefined)
      runtime.observeConnectionHealth?.(observation);
    return output;
  });
}

export function createSlackSendMessageExecutorRegistration(
  dependencies: SlackSendMessageExecutorDependencies,
): NodeExecutorRegistration {
  return Object.freeze({
    executor: SLACK_SEND_MESSAGE_EXECUTOR,
    execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
      (dependencies.telemetry ?? NOOP_TELEMETRY).measure(() =>
        execute(dependencies, invocation),
      ),
  });
}

function rethrowSlackDispatchError(
  error: unknown,
  runtime: NodeExecutionRuntime,
): never {
  if (safeInstanceOf(error, SlackSendMessageExecutorError)) throw error;
  const secureError = inspectSecureHttpError(error);
  if (secureError !== undefined) {
    if (runtime.providerDispatchUnresolved ?? false)
      throw failure('outcome_unknown', 'provider', {
        possiblyDispatched: true,
      });
    if (secureError.code === SECURE_HTTP_ERROR_CODE.connectionFenceFailed)
      throw failure('failed', 'authentication', {
        possiblyDispatched: false,
      });
    if (secureError.code === SECURE_HTTP_ERROR_CODE.dispatchBindingMismatch)
      throw failure('failed', 'configuration', {
        possiblyDispatched: false,
      });
    if (secureError.code === SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed)
      throw failure('retry', 'provider', { possiblyDispatched: false });
    if (secureError.code === SECURE_HTTP_ERROR_CODE.canceled) {
      if (!secureError.possiblyDispatched)
        throw failure('canceled', 'canceled', {
          possiblyDispatched: false,
        });
      throw failure('outcome_unknown', 'provider', {
        possiblyDispatched: true,
      });
    }
    if (!secureError.possiblyDispatched)
      throw failure(
        'retry',
        secureError.code === SECURE_HTTP_ERROR_CODE.timedOut
          ? 'timeout'
          : 'network',
        { possiblyDispatched: false },
      );
    throw failure(
      'outcome_unknown',
      secureError.code === SECURE_HTTP_ERROR_CODE.timedOut
        ? 'timeout'
        : 'network',
      { possiblyDispatched: true },
    );
  }
  throw failure('outcome_unknown', 'network', { possiblyDispatched: true });
}
