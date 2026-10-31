import type {
  NodeArtifactRuntime,
  NodeConnectionRuntime,
  NodeExecutionInvocation,
  NodeExecutionRuntime,
  ResolvedHttpCredential,
  ResolvedNodeConnection,
} from '@pertexo/node-sdk/server';
import { vi } from 'vitest';
import { HTTP_REQUEST_CONNECTION_SLOT } from '../../src/index.js';
import type {
  HttpRequestExecutorDependencies,
  SecureHttpBodyConsumer,
  SecureHttpResponse,
  SecureHttpRequest,
} from '../../src/server.js';
const workspaceId = '11111111-1111-4111-8111-111111111111';
export const connectionId = '22222222-2222-4222-8222-222222222222';
export const secretVersionId = '33333333-3333-4333-8333-333333333333';
export const encoder = new TextEncoder();
export function config(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    url: 'https://provider.example.test/v1/items',
    headers: { accept: 'application/json' },
    timeoutMillis: 10_000,
    maxRedirects: 2,
    maxResponseBytes: 1_048_576,
    inlineResponseBytes: 65_536,
    ...overrides,
  };
}
export function credentialBytes(): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      type: 'http_headers',
      headers: { authorization: 'Bearer executor-secret' },
    }),
  );
}
/**
 * A connection's stub in these tests answers through `resolve`, as a header
 * connection does; the step asks for its credential with `resolveHttpCredential`.
 */
export function httpConnections(
  connections: NodeConnectionRuntime,
): NodeConnectionRuntime {
  return {
    ...connections,
    resolveHttpCredential: (input) =>
      connections.resolve({
        ...input,
        expectedProviderKey: 'http',
        expectedAuthType: 'http_headers',
      }) as Promise<ResolvedHttpCredential>,
  };
}

export function runtime(overrides: Partial<NodeExecutionRuntime> = {}) {
  const secret = credentialBytes();
  const resolved: ResolvedNodeConnection = {
    connectionId,
    providerKey: 'http',
    authType: 'http_headers',
    secretVersionId,
    secret,
  };
  const beforeDispatch = vi.fn<NodeExecutionRuntime['beforeDispatch']>(() =>
    Promise.resolve(),
  );
  const resolve = vi.fn(() => Promise.resolve(resolved));
  const assertCurrent = vi.fn<
    NonNullable<NodeConnectionRuntime['assertCurrent']>
  >(() => Promise.resolve());
  const written: number[] = [];
  const write = vi.fn(
    async (input: Parameters<NodeArtifactRuntime['write']>[0]) => {
      for await (const chunk of input.body) written.push(...chunk);
      return {
        artifactId: '44444444-4444-4444-8444-444444444444',
        byteLength: written.length,
        mediaType: input.mediaType,
        sha256: 'a'.repeat(64),
      };
    },
  );
  return {
    value: {
      workspaceId,
      runId: '55555555-5555-4555-8555-555555555555',
      nodeRunId: '66666666-6666-4666-8666-666666666666',
      attemptId: '77777777-7777-4777-8777-777777777777',
      attemptNumber: 1,
      nodeId: 'http-node',
      invocationKey: 'http-node-invocation',
      sideEffectClass: 'unsafe' as const,
      beforeDispatch,
      connections: httpConnections({ assertCurrent, resolve }),
      artifacts: { write },
      ...overrides,
      ...(overrides.connections === undefined
        ? {}
        : { connections: httpConnections(overrides.connections) }),
    } satisfies NodeExecutionRuntime,
    beforeDispatch,
    assertCurrent,
    resolve,
    secret,
    written,
    write,
  };
}
export function invocation(
  executionRuntime: NodeExecutionRuntime,
  overrides: Partial<NodeExecutionInvocation<unknown, unknown>> = {},
): NodeExecutionInvocation<unknown, unknown> {
  return {
    config: config(),
    input: { body: { encoding: 'utf8', value: '{"ok":true}' } },
    connectionRefs: { [HTTP_REQUEST_CONNECTION_SLOT]: connectionId },
    signal: new AbortController().signal,
    runtime: executionRuntime,
    ...overrides,
  };
}
export function response(body: Uint8Array, status = 201): SecureHttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body,
    bodyEncoding: 'utf8',
    finalUrl: 'https://provider.example.test',
    redirectCount: 0,
  };
}
export function streamingHttpClient(
  execute: (request: SecureHttpRequest) => Promise<SecureHttpResponse>,
): HttpRequestExecutorDependencies['httpClient'] {
  const executeStreaming = async <Body>(
    request: SecureHttpRequest,
    consume: SecureHttpBodyConsumer<Body>,
  ): Promise<SecureHttpResponse<Body>> => {
    const buffered = await execute(request);
    const signal = request.signal ?? new AbortController().signal;
    const body = await consume({
      ...buffered,
      body: (async function* (): AsyncGenerator<Uint8Array> {
        await Promise.resolve();
        yield buffered.body;
      })(),
      signal,
    });
    return { ...buffered, body };
  };
  return { executeStreaming };
}
