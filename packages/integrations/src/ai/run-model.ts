import { MODEL_LIMITS } from './model-settings.js';
import {
  type NodeExecutionInvocation,
  NodeExecutorFailure,
  withProviderCredential,
} from '@pertexo/node-sdk/server';
import {
  MODEL_AUTH_TYPE,
  MODEL_PROVIDER_KEY,
  modelCredentialSchema,
} from './connections.definition.js';
import type { ModelClient } from './model-client.js';
import { trackModelUsage } from './model-usage.js';
import { modelRequest } from './model-request.js';
import { modelFailure } from './model/model.errors.js';
import type { ModelConfig } from './model/model.schemas.js';
import { compileBoundedObjectSchema } from '../structured-data/object-schema.js';
import {
  createProviderBeforeDispatch,
  markingDispatchOnce,
} from '../providers/provider-dispatch-fence.js';
import {
  connectionLookupFailure,
  providerFailure,
} from '../providers/provider.errors.js';

const failure = providerFailure(NodeExecutorFailure);

export async function runModel({
  client,
  invocation,
  config,
  prompt,
  purpose,
  now,
}: Readonly<{
  client: ModelClient;
  invocation: NodeExecutionInvocation<unknown, unknown>;
  config: ModelConfig;
  prompt: string;
  purpose: string;
  now: () => number;
}>) {
  const context = attemptContext(invocation, config, now);
  const validator =
    config.mode === 'structured'
      ? compileBoundedObjectSchema(config.outputSchema)
      : undefined;
  if (config.mode === 'structured' && validator === undefined)
    throw failure('failed', 'configuration', { possiblyDispatched: false });

  const {
    runtime,
    connections,
    assertCurrent,
    connectionId,
    deadline,
    signal,
  } = context;
  const identity = {
    connectionId,
    expectedProviderKey: MODEL_PROVIDER_KEY,
    expectedAuthType: MODEL_AUTH_TYPE,
  };
  let resolved;
  try {
    resolved = await connections.resolve({
      ...identity,
      purpose,
      signal,
    });
  } catch (error: unknown) {
    if (context.timedOut())
      throw modelFailure('provider_timeout', {
        kind: 'retry',
        possiblyDispatched: false,
      });
    throw connectionLookupFailure(error, { failure, runtime, signal });
  }
  const beforeDispatch = createProviderBeforeDispatch({
    ...identity,
    secretVersionId: resolved.secretVersionId,
    assertCurrent,
    runtime: markingDispatchOnce(runtime),
    signal,
  });
  return withProviderCredential(
    resolved,
    {
      connectionId,
      providerKey: MODEL_PROVIDER_KEY,
      authTypes: [MODEL_AUTH_TYPE],
      schema: modelCredentialSchema,
      refuse: () =>
        modelFailure('credential_rejected', { possiblyDispatched: false }),
    },
    async (credential) => {
      const usage = trackModelUsage(config.model, runtime.observeModelUsage);
      const complete = (repair?: { answer: unknown }) => {
        const timeoutMillis = deadline - now();
        if (timeoutMillis <= 0)
          throw modelFailure('provider_timeout', {
            kind: 'retry',
            possiblyDispatched: repair !== undefined,
          });
        return client.complete(
          modelRequest(credential.endpoint, config, prompt, repair),
          {
            credential,
            signal,
            timeoutMillis,
            usage,
            earlierDispatch: repair !== undefined,
            beforeDispatch,
          },
        );
      };
      const first = await complete();
      if (validator === undefined && first.kind === 'text')
        return { text: first.text };
      if (first.kind === 'proposal')
        throw modelFailure('invalid_response', { possiblyDispatched: true });
      const answer = candidate(first);
      if (validator?.(answer)) return { data: answer };
      const repaired = candidate(
        await complete({
          answer: first.kind === 'text' ? first.text : first.data,
        }),
      );
      if (validator?.(repaired)) return { data: repaired };
      throw modelFailure('output_schema_invalid', {
        possiblyDispatched: true,
      });
    },
  );
}

function attemptContext(
  invocation: NodeExecutionInvocation<unknown, unknown>,
  config: ModelConfig,
  now: () => number,
) {
  const runtime = invocation.runtime;
  const connections = runtime?.connections;
  const assertCurrent = connections?.assertCurrent;
  const connectionId = invocation.connectionRefs[MODEL_AUTH_TYPE];
  if (
    runtime?.sideEffectClass !== 'safe' ||
    runtime.providerIdempotencyKey !== undefined ||
    connections === undefined ||
    assertCurrent === undefined ||
    connectionId === undefined ||
    Object.keys(invocation.connectionRefs).length !== 1
  )
    throw failure('failed', 'configuration', { possiblyDispatched: false });
  const startedAt = now();
  const deadline = Math.min(
    startedAt + (config.timeoutMillis ?? MODEL_LIMITS.defaultTimeoutMillis),
    runtime.deadlineAt?.getTime() ?? Infinity,
  );
  if (deadline <= startedAt)
    throw modelFailure('provider_timeout', {
      kind: 'retry',
      possiblyDispatched: false,
    });
  const timeout = AbortSignal.timeout(deadline - startedAt);
  const signal = AbortSignal.any([invocation.signal, timeout]);
  return {
    runtime,
    connections,
    assertCurrent,
    connectionId,
    deadline,
    signal,
    timedOut: () => signal.aborted && signal.reason === timeout.reason,
  };
}

function candidate(
  completion: Awaited<ReturnType<ModelClient['complete']>>,
): unknown {
  if (completion.kind === 'structured') return completion.data;
  if (completion.kind !== 'text') return undefined;
  try {
    return JSON.parse(completion.text) as unknown;
  } catch {
    return undefined;
  }
}
