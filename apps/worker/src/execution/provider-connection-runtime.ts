import {
  CONNECTION_AUTH_TYPE,
  ConnectionUnavailableError,
  type ConnectionResolutionDatabase,
} from '@pertexo/database/execution';
import type { ConnectionEnvelopeEncryption } from '@pertexo/integrations/server';
import {
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
  type NodeConnectionRuntime,
} from '@pertexo/node-sdk/server';
import {
  AbuseRateLimitPolicy,
  type DistributedRateLimitResult,
  type RateLimitDecision,
} from '@pertexo/rate-limit';

import type { NodeAttemptCapabilityContext } from './node-attempt-handler.js';

export type ProviderRateLimiter = Readonly<{
  consume(decision: RateLimitDecision): Promise<DistributedRateLimitResult>;
}>;

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

export function createProviderConnectionRuntimeFactory(
  database: ConnectionResolutionDatabase,
  encryption: Pick<ConnectionEnvelopeEncryption, 'open'>,
  providerRateLimiter: ProviderRateLimiter,
): (context: NodeAttemptCapabilityContext) => NodeConnectionRuntime {
  return (context) =>
    Object.freeze({
      resolve: async (
        input: Parameters<NodeConnectionRuntime['resolve']>[0],
      ) => {
        assertNotAborted(input.signal);
        const admission = await providerRateLimiter.consume(
          new AbuseRateLimitPolicy().evaluate('provider_execution', {
            workspaceId: context.workspaceId,
            connectionId: input.connectionId,
          }),
        );
        if (!admission.allowed)
          throw new ProviderExecutionRateLimitError(
            admission.retryAfterSeconds,
          );
        let resolved;
        try {
          resolved = await database.resolveConnectionSecret({
            workspaceId: context.workspaceId,
            connectionId: input.connectionId,
            expectedProviderKey: input.expectedProviderKey,
            workerId: context.workerId,
            purpose: input.purpose,
          });
        } catch (error: unknown) {
          if (error instanceof ConnectionUnavailableError)
            throw new ProviderCredentialInvalidError();
          throw error;
        }
        if (
          resolved.connection.authType !== input.expectedAuthType ||
          resolved.connection.id !== input.connectionId ||
          resolved.connection.workspaceId !== context.workspaceId
        )
          throw new ProviderCredentialInvalidError();
        const secret = await encryption.open(
          resolved.sealed,
          {
            workspaceId: context.workspaceId,
            connectionId: input.connectionId,
            secretVersionId: resolved.secretVersionId,
          },
          input.signal,
        );
        if (input.signal.aborted) {
          secret.fill(0);
          throw abortError();
        }
        return Object.freeze({
          connectionId: resolved.connection.id,
          providerKey: resolved.connection.providerKey,
          authType: resolved.connection.authType,
          secretVersionId: resolved.secretVersionId,
          secret,
        });
      },
      assertCurrent: async (
        input: Parameters<
          NonNullable<NodeConnectionRuntime['assertCurrent']>
        >[0],
      ): Promise<void> => {
        assertNotAborted(input.signal);
        if (
          input.expectedAuthType !== CONNECTION_AUTH_TYPE.httpHeaders &&
          input.expectedAuthType !== CONNECTION_AUTH_TYPE.slackBotToken &&
          input.expectedAuthType !== CONNECTION_AUTH_TYPE.resendApiKey
        )
          throw new ProviderCredentialInvalidError();
        try {
          await database.assertConnectionSecretCurrent({
            workspaceId: context.workspaceId,
            connectionId: input.connectionId,
            expectedProviderKey: input.expectedProviderKey,
            expectedAuthType: input.expectedAuthType,
            secretVersionId: input.secretVersionId,
          });
        } catch (error: unknown) {
          if (error instanceof ConnectionUnavailableError)
            throw new ProviderCredentialInvalidError();
          throw error;
        }
        assertNotAborted(input.signal);
      },
    });
}
