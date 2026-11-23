import { ReadableStream } from 'node:stream/web';
import { isDeepStrictEqual } from 'node:util';
import type {
  ConnectionDefinition,
  ProviderHttpClient,
  ProviderHttpBodyConsumer,
  ProviderHttpRequest,
} from '@pertexo/integrations/server';
import {
  createPlatformNodeRegistry,
  type loadAuthorCommunityRelease,
} from '@pertexo/node-catalog/server';
import {
  NodeInputValidationError,
  NodeOutputValidationError,
  type NodeConnectionRuntime,
} from '@pertexo/node-sdk/server';
import { z } from 'zod';
import {
  SYNTHETIC_CREDENTIAL_PREFIX,
  type ConformanceExample,
} from './conformance.schemas.js';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';

export async function checkExample(
  release: Awaited<ReturnType<typeof loadAuthorCommunityRelease>>,
  example: ConformanceExample,
  signal: AbortSignal,
) {
  const { metadata, module, credentialFields } = release;
  const step = module.steps.find(
    ({ registration }) =>
      registration.manifest.integration?.operationKey === example.operation,
  );
  if (step === undefined)
    throw new Error('.operation: use an operation key from the release.');
  const manifest = step.registration.manifest;
  const connection = module.connections?.find(({ slot }) =>
    manifest.connectionRequirements.includes(slot.key),
  );
  const provider = fixtureProvider(metadata.origin, example, signal);
  const registry = createPlatformNodeRegistry({
    httpClient: provider.client,
    fixedEndpointHttpClient: provider.client,
  });
  let result;
  try {
    result = await registry.execute({
      ...manifest,
      config: {},
      input: example.input,
      signal,
      connectionRefs:
        connection === undefined
          ? {}
          : { [connection.slot.key]: CONNECTION_ID },
      runtime: {
        workspaceId: CONNECTION_ID,
        runId: CONNECTION_ID,
        nodeRunId: CONNECTION_ID,
        attemptId: CONNECTION_ID,
        attemptNumber: 1,
        nodeId: example.operation,
        invocationKey: example.operation,
        sideEffectClass: manifest.retryClass === 'safe' ? 'safe' : 'unsafe',
        beforeDispatch: () => Promise.resolve(),
        ...(connection === undefined
          ? {}
          : {
              connections: fixtureConnection(
                metadata.providerKey,
                connection,
                credentialFields,
              ),
            }),
      },
    });
  } catch (cause) {
    provider.verifyRequest();
    if (cause instanceof NodeInputValidationError)
      throw executionFailure('input', cause);
    if (cause instanceof NodeOutputValidationError)
      throw executionFailure('response.body', cause);
    const message =
      cause instanceof Error ? cause.message : 'Operation failed.';
    throw new Error(
      `.${provider.dispatched() ? 'response' : 'input'}: ${message}`,
      { cause },
    );
  }
  provider.verifyRequest();
  if (!provider.dispatched())
    throw new Error('.request: the operation did not send a request.');
  if (!isDeepStrictEqual(result.output, example.output))
    throw new Error(
      '.output: the projected response did not match the expected output.',
    );
}

function executionFailure(
  field: string,
  error: NodeInputValidationError | NodeOutputValidationError,
) {
  let detail = error.message;
  if (error.cause instanceof z.ZodError) detail = z.prettifyError(error.cause);
  else if (typeof error.cause === 'string') detail = error.cause;
  return new Error(`.${field}: ${detail}`, { cause: error });
}

function fixtureConnection(
  providerKey: string,
  { authType, slot }: ConnectionDefinition,
  credentialFields: readonly string[],
): NodeConnectionRuntime {
  const credential = Object.fromEntries(
    credentialFields.map((key) => [key, SYNTHETIC_CREDENTIAL_PREFIX + key]),
  );
  return {
    resolve(input) {
      if (
        input.connectionId !== CONNECTION_ID ||
        input.expectedProviderKey !== providerKey ||
        input.expectedAuthType !== slot.key
      )
        throw new Error(
          'The operation requested an unexpected fixture connection.',
        );
      return Promise.resolve({
        connectionId: CONNECTION_ID,
        providerKey,
        authType,
        secretVersionId: VERSION_ID,
        secret: Buffer.from(JSON.stringify({ ...credential, type: authType })),
      });
    },
    assertCurrent(input) {
      if (
        input.connectionId !== CONNECTION_ID ||
        input.expectedProviderKey !== providerKey ||
        input.expectedAuthType !== authType ||
        input.secretVersionId !== VERSION_ID
      )
        throw new Error(
          'The operation dispatched with an unexpected fixture connection.',
        );
      return Promise.resolve();
    },
  };
}

function fixtureProvider(
  origin: string,
  example: ConformanceExample,
  signal: AbortSignal,
) {
  let requested = false;
  let mismatch: string | undefined;
  const client: ProviderHttpClient = {
    execute() {
      throw new Error('Unexpected fixed-endpoint request.');
    },
    async executeStreaming<Body>(
      request: ProviderHttpRequest,
      consume: ProviderHttpBodyConsumer<Body>,
    ) {
      if (requested) {
        mismatch = '.request: the operation sent more than one request.';
        throw new Error(mismatch);
      }
      const url = new URL(request.url);
      if (
        url.origin !== origin ||
        request.maxRedirects !== 0 ||
        request.publicOnly !== true
      ) {
        mismatch =
          '.request: the operation must use the approved origin without redirects.';
        throw new Error(mismatch);
      }
      await request.beforeDispatch();
      requested = true;
      mismatch = compareRequest(example.request, request, url);
      const { status, body } = example.response;
      const response = {
        status,
        headers:
          body === undefined ? {} : { 'content-type': 'application/json' },
        bodyEncoding: 'utf8' as const,
        finalUrl: url.href,
        redirectCount: 0,
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (body !== undefined)
            controller.enqueue(Buffer.from(JSON.stringify(body)));
          controller.close();
        },
      });
      return {
        ...response,
        body: await consume({ ...response, body: stream, signal }),
      };
    },
    redactText(value, sensitiveValues) {
      return sensitiveValues.reduce(
        (text, sensitive) => text.replaceAll(sensitive, '[redacted]'),
        value,
      );
    },
  };
  return {
    client,
    dispatched: () => requested,
    verifyRequest() {
      if (mismatch !== undefined) throw new Error(mismatch);
    },
  };
}

function compareRequest(
  expected: ConformanceExample['request'],
  request: ProviderHttpRequest,
  url: URL,
) {
  if (expected.method !== request.method)
    return '.request.method: does not match the generated request.';
  if (expected.path !== url.pathname + url.search)
    return '.request.path: does not match the generated path and query.';
  if (!isDeepStrictEqual(expected.headers, { ...request.headers }))
    return '.request.headers: do not match the generated headers.';
  const body: unknown =
    request.body instanceof Uint8Array
      ? JSON.parse(Buffer.from(request.body).toString('utf8'))
      : request.body;
  if (!isDeepStrictEqual(expected.body, body))
    return '.request.body: does not match the generated body.';
  return undefined;
}
