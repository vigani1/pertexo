import {
  DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
  NodeExecutorFailure,
} from '@pertexo/node-sdk/server';

import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '../http/secure-http.js';
import type { SlackApiResult, SlackClient } from './client.js';
import {
  SLACK_BOT_TOKEN_CONNECTION_SLOT,
  SLACK_SEND_MESSAGE_DEFINITION,
  SLACK_SEND_MESSAGE_EXECUTOR,
  SLACK_SEND_MESSAGE_POLICY,
} from './definition.js';
import {
  slackBotTokenCredentialSchema,
  slackSendMessageConfigSchema,
  slackSendMessageInputSchema,
  slackSendMessageOutputSchema,
  type SlackSendMessageOutput,
} from './validation.js';

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

export class SlackSendMessageExecutorError extends NodeExecutorFailure {
  public override readonly name = 'SlackSendMessageExecutorError';
  public constructor(
    outcome: ConstructorParameters<typeof NodeExecutorFailure>[0],
    public readonly retryAfterMillis?: number,
  ) {
    super(outcome);
  }
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
): SlackSendMessageExecutorError {
  return new SlackSendMessageExecutorError(
    { kind, errorKind, possiblyDispatched },
    retryAfterMillis,
  );
}

function classifyResult(
  result: Exclude<SlackApiResult, { kind: 'succeeded' }>,
): never {
  switch (result.kind) {
    case 'rate_limited':
      throw failure('retry', 'rate_limit', false, result.retryAfterMillis);
    case 'http_failure':
      if (result.status === 401 || result.status === 403)
        throw failure('failed', 'authentication', false);
      throw failure('outcome_unknown', 'provider', true);
    case 'invalid_response':
      throw failure('outcome_unknown', 'provider', true);
    case 'rejected':
      if (AUTH_ERRORS.has(result.error))
        throw failure('failed', 'authentication', false);
      if (DEFINITE_ERRORS.has(result.error))
        throw failure('failed', 'provider', false);
      if (RETRYABLE_ERRORS.has(result.error))
        throw failure('retry', 'provider', false);
      throw failure('outcome_unknown', 'provider', true);
  }
}

async function execute(
  dependencies: SlackSendMessageExecutorDependencies,
  invocation: NodeExecutionInvocation<unknown, unknown>,
): Promise<SlackSendMessageOutput> {
  let config;
  let input;
  try {
    config = slackSendMessageConfigSchema.parse(invocation.config);
    input = slackSendMessageInputSchema.parse(invocation.input);
  } catch {
    throw failure('failed', 'configuration', false);
  }
  const runtime = invocation.runtime;
  const connections = runtime?.connections;
  const connectionId =
    invocation.connectionRefs[SLACK_BOT_TOKEN_CONNECTION_SLOT];
  if (
    runtime === undefined ||
    connections?.assertCurrent === undefined ||
    runtime.sideEffectClass !== 'unsafe' ||
    runtime.providerIdempotencyKey !== undefined ||
    connectionId === undefined ||
    Object.keys(invocation.connectionRefs).length !== 1
  )
    throw failure('failed', 'configuration', false);

  let resolved;
  try {
    resolved = await connections.resolve({
      connectionId,
      expectedProviderKey: 'slack',
      expectedAuthType: 'slack_bot_token',
      purpose: 'slack.send_message.execute',
      signal: invocation.signal,
    });
  } catch {
    throw failure('failed', 'authentication', false);
  }
  try {
    if (
      resolved.connectionId !== connectionId ||
      resolved.providerKey !== 'slack' ||
      resolved.authType !== 'slack_bot_token'
    )
      throw failure('failed', 'configuration', false);
    let credential;
    try {
      credential = slackBotTokenCredentialSchema.parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(resolved.secret),
        ),
      );
    } catch {
      throw failure('failed', 'authentication', false);
    }
    let result;
    try {
      result = await dependencies.client.sendMessage({
        botToken: credential.botToken,
        channelId: input.channelId,
        text: input.text,
        timeoutMillis: config.timeoutMillis,
        signal: invocation.signal,
        beforeDispatch: async () => {
          await connections.assertCurrent?.({
            connectionId,
            expectedProviderKey: 'slack',
            expectedAuthType: 'slack_bot_token',
            secretVersionId: resolved.secretVersionId,
            signal: invocation.signal,
          });
          await runtime.beforeDispatch();
        },
      });
    } catch (error: unknown) {
      if (error instanceof SlackSendMessageExecutorError) throw error;
      if (error instanceof SecureHttpError) {
        if (error.code === SECURE_HTTP_ERROR_CODE.canceled) {
          if (!error.possiblyDispatched)
            throw failure('canceled', 'canceled', false);
          throw failure('outcome_unknown', 'provider', true);
        }
        if (!error.possiblyDispatched)
          throw failure(
            'retry',
            error.code === SECURE_HTTP_ERROR_CODE.timedOut
              ? 'timeout'
              : 'network',
            false,
          );
        throw failure(
          'outcome_unknown',
          error.code === SECURE_HTTP_ERROR_CODE.timedOut
            ? 'timeout'
            : 'network',
          true,
        );
      }
      throw failure('outcome_unknown', 'network', true);
    }
    if (result.kind !== 'succeeded') classifyResult(result);
    if (result.channelId !== input.channelId)
      throw failure('outcome_unknown', 'provider', true);
    return slackSendMessageOutputSchema.parse({
      channelId: result.channelId,
      messageTs: result.messageTs,
    });
  } finally {
    resolved.secret.fill(0);
  }
}

export function createSlackSendMessageExecutorRegistration(
  dependencies: SlackSendMessageExecutorDependencies,
  lifecycle: NodeExecutorRegistration['lifecycle'] = 'staged',
): NodeExecutorRegistration {
  return Object.freeze({
    abiVersion: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
    definitions: Object.freeze([SLACK_SEND_MESSAGE_DEFINITION]),
    executor: SLACK_SEND_MESSAGE_EXECUTOR,
    lifecycle,
    policyReferences: Object.freeze([SLACK_SEND_MESSAGE_POLICY]),
    execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
      (dependencies.telemetry ?? NOOP_TELEMETRY).measure(() =>
        execute(dependencies, invocation),
      ),
  });
}
