import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import {
  DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  NodeExecutorFailure,
  withProviderCredential,
  type NodeExecutionInvocation,
} from '@pertexo/node-sdk/server';
import { z } from 'zod';
import {
  DEFAULT_POST_ID,
  EXAMPLE_POSTS_CONNECTION,
  EXAMPLE_POSTS_ORIGIN,
  examplePostSchema,
} from './connections.definition.js';
import {
  classifySecureHttpError,
  classifySecureHttpResponse,
} from '../http/outcome-policy.js';
import { HttpRequestExecutorError } from '../http/request/request.errors.js';
import { inspectProviderHttpError } from '../providers/http.errors.js';
import type {
  IntegrationExecutorDependencies,
  IntegrationModule,
} from '../providers/integration-module.js';
import { createProviderBeforeDispatch } from '../providers/provider-dispatch-fence.js';
import {
  connectionLookupFailure,
  providerFailure,
} from '../providers/provider.errors.js';
import { registerProviderExecutor } from '../providers/provider-executor.js';
import { PROVIDER_STEP_TIMEOUT } from '../providers/provider-timeout.js';

const MAX_POST_RESPONSE_BYTES = 16 * 1024;
const INVALID_POST_CODE = 'example_posts.invalid_post';
const provider = { key: 'example_posts' } as const;
const identity = { key: 'example_posts.get_post', version: 1 } as const;
const configSchema = z.strictObject({
  postId: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_POST_ID)
    .meta({ title: 'Post ID' }),
});
const inputSchema = z.strictObject({});
const outputSchema = z.strictObject({ post: examplePostSchema });
const manifest: NodeManifest = {
  definition: identity,
  executor: identity,
  executorAbi: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  family: 'action',
  display: { name: 'Get post', description: 'Read one Example Posts record' },
  configVersion: 1,
  configSchema: generateSchemaDocument(configSchema),
  inputSchema: generateSchemaDocument(inputSchema),
  outputSchema: generateSchemaDocument(outputSchema),
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [EXAMPLE_POSTS_CONNECTION.authType],
  connectionRequirements: [EXAMPLE_POSTS_CONNECTION.authType],
  integration: { providerKey: provider.key, operationKey: 'get_post' },
  retryClass: 'safe',
  resourceClass: 'io',
  capabilities: ['external_http'],
  policyReferences: [],
};

const failure = providerFailure(NodeExecutorFailure);
const outcomePolicy = { providerKeyPresent: false };

export const EXAMPLE_POSTS_MODULE = {
  key: provider.key,
  presentation: { name: 'Example Posts', icon: 'globe', group: 'action' },
  connections: [EXAMPLE_POSTS_CONNECTION],
  executorSummaryCodes: [INVALID_POST_CODE],
  steps: [
    {
      registration: { manifest, configSchema, inputSchema, outputSchema },
      createExecutor: (dependencies) =>
        registerProviderExecutor(identity, undefined, (invocation) =>
          getPost(dependencies, invocation),
        ),
    },
  ],
} satisfies IntegrationModule;

async function getPost(
  { fixedEndpointHttpClient, httpClient }: IntegrationExecutorDependencies,
  invocation: NodeExecutionInvocation<unknown, unknown>,
): Promise<z.output<typeof outputSchema>> {
  const { postId } = invocation.config as z.output<typeof configSchema>;
  const { runtime, signal } = invocation;
  const connections = runtime?.connections;
  const assertCurrent = connections?.assertCurrent;
  const connectionId =
    invocation.connectionRefs[EXAMPLE_POSTS_CONNECTION.authType];
  if (
    runtime === undefined ||
    connections === undefined ||
    assertCurrent === undefined ||
    connectionId === undefined
  )
    throw failure('failed', 'configuration', { possiblyDispatched: false });

  const expectedProviderKey = provider.key;
  const expectedAuthType = EXAMPLE_POSTS_CONNECTION.authType;
  let resolved;
  try {
    resolved = await connections.resolve({
      connectionId,
      expectedProviderKey,
      expectedAuthType,
      purpose: 'example_posts.get_post.execute',
      signal,
    });
  } catch (error: unknown) {
    throw connectionLookupFailure(error, { failure, runtime, signal });
  }

  return withProviderCredential(
    resolved,
    {
      connectionId,
      providerKey: expectedProviderKey,
      authTypes: [expectedAuthType],
      schema: EXAMPLE_POSTS_CONNECTION.schema,
      refuse: (reason) =>
        failure('failed', reason, { possiblyDispatched: false }),
    },
    async ({ apiKey }) => {
      const sensitiveValues = [
        apiKey,
        ...(runtime.callbacks?.sensitiveValues() ?? []),
      ];
      let response;
      try {
        response = await fixedEndpointHttpClient.execute({
          url: `${EXAMPLE_POSTS_ORIGIN}/posts/${String(postId)}`,
          method: 'GET',
          headers: {
            accept: 'application/json',
            [EXAMPLE_POSTS_CONNECTION.auth.name]: apiKey,
          },
          sensitiveValues,
          signal,
          timeoutMillis: PROVIDER_STEP_TIMEOUT.defaultMillis,
          maxRedirects: 0,
          maxResponseBytes: MAX_POST_RESPONSE_BYTES,
          beforeDispatch: createProviderBeforeDispatch({
            assertCurrent,
            connectionId,
            expectedProviderKey,
            expectedAuthType,
            secretVersionId: resolved.secretVersionId,
            signal,
            runtime,
          }),
        });
      } catch (error: unknown) {
        const secureError = inspectProviderHttpError(error);
        if (secureError === undefined) throw error;
        throw new HttpRequestExecutorError(
          classifySecureHttpError(secureError, 'safe', outcomePolicy),
          { possiblyDispatched: secureError.possiblyDispatched },
        );
      }

      try {
        const decision = classifySecureHttpResponse(response.status, 'safe', {
          ...outcomePolicy,
          headers: response.headers,
        });
        if (decision.kind !== 'succeeded')
          throw new HttpRequestExecutorError(decision, {
            possiblyDispatched: true,
          });
        const post = decodePost(response.body, postId);
        return {
          post: {
            ...post,
            title: httpClient.redactText(post.title, sensitiveValues),
            body: httpClient.redactText(post.body, sensitiveValues),
          },
        };
      } finally {
        response.body.fill(0);
      }
    },
  );
}

function decodePost(bytes: Uint8Array, postId: number) {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    const result = examplePostSchema.safeParse(value);
    if (result.success && result.data.id === postId) return result.data;
  } catch {
    // Decoder diagnostics can include provider-supplied response text.
  }
  throw new NodeExecutorFailure({
    kind: 'failed',
    errorKind: 'provider',
    possiblyDispatched: true,
    safeErrorCode: INVALID_POST_CODE,
    errorSummary: 'Example Posts returned an invalid post.',
  });
}
