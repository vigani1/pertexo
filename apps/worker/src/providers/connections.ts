import {
  CONNECTION_AUTH_TYPE,
  ConnectionOAuth2NotConnectedError,
  ConnectionUnavailableError,
  type ConnectionResolutionDatabase,
} from '@pertexo/database/connections';
import {
  OAuth2TokenFailure,
  type ConnectionEnvelopeEncryption,
  type OAuth2TokenScope,
  type OAuth2TokenService,
} from '@pertexo/integrations/server';
import {
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
  type NodeConnectionRuntime,
  type ResolvedHttpCredential,
} from '@pertexo/node-sdk/server';
import {
  AbuseRateLimitPolicy,
  type DistributedRateLimitResult,
  type RateLimitDecision,
} from '@pertexo/rate-limit';

import type { NodeExecutionCapabilityContext } from '../attempts/execution/capabilities.js';

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
  tokens?: Pick<OAuth2TokenService, 'accessToken' | 'rejectToken'>,
): (context: NodeExecutionCapabilityContext) => NodeConnectionRuntime {
  return (context) => {
    const admit = async (
      input: Readonly<{ connectionId: string; signal: AbortSignal }>,
    ): Promise<void> => {
      assertNotAborted(input.signal);
      const admission = await providerRateLimiter.consume(
        new AbuseRateLimitPolicy().evaluate('provider_execution', {
          workspaceId: context.workspaceId,
          connectionId: input.connectionId,
        }),
      );
      assertNotAborted(input.signal);
      if (!admission.allowed)
        throw new ProviderExecutionRateLimitError(admission.retryAfterSeconds);
    };

    const resolveRecord = async (
      input: Readonly<{
        connectionId: string;
        expectedProviderKey: string;
        purpose: string;
        signal: AbortSignal;
      }>,
    ) => {
      try {
        const resolved = await database.resolveConnectionSecret({
          workspaceId: context.workspaceId,
          connectionId: input.connectionId,
          expectedProviderKey: input.expectedProviderKey,
          workerId: context.workerId,
          purpose: input.purpose,
          signal: input.signal,
        });
        assertNotAborted(input.signal);
        return resolved;
      } catch (error: unknown) {
        if (error instanceof ConnectionOAuth2NotConnectedError)
          throw new OAuth2TokenFailure('http.oauth2_not_connected');
        if (error instanceof ConnectionUnavailableError)
          throw new ProviderCredentialInvalidError();
        throw error;
      }
    };

    const openSecret = async (
      input: Readonly<{ connectionId: string; signal: AbortSignal }>,
      resolved: Awaited<ReturnType<typeof resolveRecord>>,
    ) => {
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
    };

    const tokenScope = (connectionId: string): OAuth2TokenScope => ({
      workspaceId: context.workspaceId,
      connectionId,
      loss: { source: 'run', workerId: context.workerId },
    });

    return Object.freeze({
      resolve: async (
        input: Parameters<NodeConnectionRuntime['resolve']>[0],
      ) => {
        await admit(input);
        let resolved;
        try {
          resolved = await resolveRecord(input);
        } catch (error: unknown) {
          // Only an HTTP step can be told an OAuth2 connection isn't connected.
          if (error instanceof OAuth2TokenFailure)
            throw new ProviderCredentialInvalidError();
          throw error;
        }
        if (resolved.connection.authType !== input.expectedAuthType)
          throw new ProviderCredentialInvalidError();
        return openSecret(input, resolved);
      },
      resolveHttpCredential: async (
        input: Parameters<
          NonNullable<NodeConnectionRuntime['resolveHttpCredential']>
        >[0],
      ): Promise<ResolvedHttpCredential> => {
        await admit(input);
        const resolved = await resolveRecord({
          ...input,
          expectedProviderKey: 'http',
        });
        if (resolved.connection.authType === CONNECTION_AUTH_TYPE.httpHeaders)
          return {
            ...(await openSecret(input, resolved)),
            authType: 'http_headers',
          };
        if (
          resolved.connection.authType !== CONNECTION_AUTH_TYPE.oauth2 ||
          tokens === undefined
        )
          throw new ProviderCredentialInvalidError();
        const token = await tokens.accessToken(
          tokenScope(input.connectionId),
          input.signal,
        );
        return Object.freeze({
          authType: 'oauth2',
          connectionId: input.connectionId,
          providerKey: 'http',
          secretVersionId: token.secretVersionId,
          accessToken: token.accessToken,
          tokenVersionId: token.tokenVersionId,
          requestHosts: token.requestHosts,
        });
      },
      rejectAccessToken: async (
        input: Parameters<
          NonNullable<NodeConnectionRuntime['rejectAccessToken']>
        >[0],
      ) =>
        tokens === undefined
          ? false
          : tokens.rejectToken(
              tokenScope(input.connectionId),
              input.tokenVersionId,
              input.signal,
            ),
      assertCurrent: async (
        input: Parameters<
          NonNullable<NodeConnectionRuntime['assertCurrent']>
        >[0],
      ): Promise<void> => {
        assertNotAborted(input.signal);
        const unsupportedAuthType =
          input.expectedAuthType !== CONNECTION_AUTH_TYPE.signingKey &&
          input.expectedAuthType !== CONNECTION_AUTH_TYPE.httpHeaders &&
          input.expectedAuthType !== CONNECTION_AUTH_TYPE.slackBotToken &&
          input.expectedAuthType !== CONNECTION_AUTH_TYPE.resendApiKey &&
          input.expectedAuthType !== CONNECTION_AUTH_TYPE.oauth2;
        if (unsupportedAuthType) throw new ProviderCredentialInvalidError();
        try {
          await database.assertConnectionSecretCurrent({
            workspaceId: context.workspaceId,
            connectionId: input.connectionId,
            expectedProviderKey: input.expectedProviderKey,
            expectedAuthType: input.expectedAuthType,
            secretVersionId: input.secretVersionId,
            signal: input.signal,
          });
        } catch (error: unknown) {
          if (error instanceof ConnectionUnavailableError)
            throw new ProviderCredentialInvalidError();
          throw error;
        }
        assertNotAborted(input.signal);
      },
    });
  };
}
