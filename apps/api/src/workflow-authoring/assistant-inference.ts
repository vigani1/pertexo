import { createHash } from 'node:crypto';
import type { AssistantSettingsStore } from '@pertexo/core/authoring';
import {
  ConnectionNotFoundError,
  ConnectionUnavailableError,
} from '@pertexo/core/connections';
import {
  createModelClient,
  modelCredentialHost,
  MODEL_AUTH_TYPE,
  MODEL_PROVIDER_KEY,
  type ModelClient,
  type runModelOnce,
} from '@pertexo/integrations/server';
import type { ModelUsage } from '@pertexo/node-sdk';
import {
  type NodeExecutorFailure,
  ProviderCredentialInvalidError,
} from '@pertexo/node-sdk/server';
import type { ConnectionLookupDependencies } from '../connections/lookups/lookup-options.service.js';
import {
  requestIdentifiers,
  type serviceCaller,
  storeContext,
} from '../workspaces/request/caller.js';

export const ASSISTANT_TIMEOUT_MILLIS = 12_000;
export const assistantIdentity = {
  providerKey: MODEL_PROVIDER_KEY,
  authType: MODEL_AUTH_TYPE,
} as const;
export type AssistantCaller = ReturnType<typeof serviceCaller>;
export type ModelRates = Readonly<
  Record<string, Readonly<{ input: number; output: number }>>
>;
export type AssistantPurpose = 'explain_run' | 'propose_draft';

type AssistantInvocation = Parameters<typeof runModelOnce>[0]['invocation'];
type AssistantPreparation =
  | { kind: 'not_configured' | 'connection_unavailable' }
  | {
      kind: 'ready';
      model: string;
      connectionName: string;
      confirmation: string;
      client: ModelClient;
      open(
        signal: AbortSignal,
      ): Promise<Parameters<typeof modelCredentialHost>[0]>;
      invocation(
        deadlineAt: Date,
        observe: (usage: ModelUsage) => void,
      ): AssistantInvocation;
    };

export async function prepareAssistant(
  settings: AssistantSettingsStore,
  connectionDependencies: ConnectionLookupDependencies | undefined,
  input: AssistantCaller,
  purpose: AssistantPurpose,
  subject: readonly (string | number)[],
  signal: AbortSignal,
): Promise<AssistantPreparation> {
  const actor = { ...storeContext(input), signal };
  const selection = await settings.read(actor);
  if (selection === null) return { kind: 'not_configured' as const };
  const dependencies = connectionDependencies;
  if (dependencies === undefined)
    return { kind: 'connection_unavailable' as const };
  const { connectionId, model } = selection;
  let resolved;
  try {
    resolved = await dependencies.persistence.resolveConnectionLookupSecret({
      ...actor,
      ...requestIdentifiers(input),
      connectionId,
      expectedProviderKey: MODEL_PROVIDER_KEY,
      purpose,
    });
  } catch (error: unknown) {
    if (error instanceof ConnectionUnavailableError)
      return { kind: 'connection_unavailable' as const };
    throw error;
  }
  const { connection, secretVersionId, sealed } = resolved;
  const confirmation = createHash('sha256')
    .update(
      JSON.stringify([
        actor.workspaceId,
        actor.actorId,
        purpose,
        subject,
        connectionId,
        model,
        secretVersionId,
        connection.name,
      ]),
    )
    .digest('base64url');
  const { persistence, encryption } = dependencies;
  return {
    kind: 'ready' as const,
    model,
    connectionName: connection.name,
    confirmation,
    client: createModelClient(dependencies.http),
    open,
    invocation: (
      deadlineAt: Date,
      observeModelUsage: (usage: ModelUsage) => void,
    ) => ({
      signal,
      connectionRefs: { [MODEL_AUTH_TYPE]: connectionId },
      runtime: {
        deadlineAt,
        sideEffectClass: 'safe' as const,
        beforeDispatch: () => Promise.resolve(),
        observeModelUsage,
        connections: {
          resolve: ({ signal: callSignal }) => open(callSignal),
          assertCurrent: async (fence) => {
            try {
              await persistence.assertConnectionLookupSecretCurrent({
                ...actor,
                connectionId: fence.connectionId,
                providerKey: fence.expectedProviderKey,
                authType: fence.expectedAuthType,
                secretVersionId: fence.secretVersionId,
                signal: fence.signal,
              });
            } catch (error: unknown) {
              if (
                error instanceof ConnectionUnavailableError ||
                error instanceof ConnectionNotFoundError
              )
                throw new ProviderCredentialInvalidError();
              throw error;
            }
          },
        },
      },
    }),
  };

  async function open(openSignal: AbortSignal) {
    return {
      ...assistantIdentity,
      connectionId,
      secretVersionId,
      secret: await encryption.open(
        sealed,
        {
          workspaceId: actor.workspaceId,
          connectionId,
          secretVersionId,
        },
        openSignal,
      ),
    };
  }
}

export async function assistantDisclosure(
  prepared: Extract<
    Awaited<ReturnType<typeof prepareAssistant>>,
    { kind: 'ready' }
  >,
  signal: AbortSignal,
) {
  return {
    kind: 'ready' as const,
    connectionName: prepared.connectionName,
    host: await modelCredentialHost(await prepared.open(signal)),
    model: prepared.model,
    confirmation: prepared.confirmation,
  };
}

export function failureOutcome(error: NodeExecutorFailure) {
  if (error.errorKind === 'timeout') return 'timeout';
  if (error.safeErrorCode === 'model.response_too_large')
    return 'response_too_large';
  if (error.safeErrorCode === 'model.invalid_response')
    return 'invalid_response';
  return 'provider_failure';
}

export function modelCost(usage: ModelUsage, rates: ModelRates | undefined) {
  const rate =
    rates !== undefined && Object.hasOwn(rates, usage.model)
      ? rates[usage.model]
      : undefined;
  if (usage.kind !== 'complete' || rate === undefined) return null;
  const cost =
    usage.inputTokens * rate.input + usage.outputTokens * rate.output;
  return Number.isSafeInteger(cost) ? cost : null;
}
