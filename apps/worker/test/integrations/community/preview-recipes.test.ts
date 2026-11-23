import { randomUUID } from 'node:crypto';
import {
  ProviderCredentialInvalidError,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import {
  parseAllowedPrivateNetworks,
  SecureHttpClient,
  type SecureHttpTransport,
} from '@pertexo/secrets/server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { provideHttpClient } from '../../../src/providers/http-client.js';
import { createPlatformNodeRegistry } from '../../../src/providers/node-registry.js';
import {
  cleanAppsWorkerTestPreviewsRuntimeTestRuntimeTestTsFixture,
  createPlatformPreviewNodeInvoker,
  leaseFixture,
} from '../../previews/preview-runtime.fixture.js';
import {
  approveRecipes,
  origin,
  providerKey,
  readPath,
  recipeForm,
  recipeNode,
  token,
} from './recipes.fixture.js';

beforeAll(approveRecipes);
afterAll(cleanAppsWorkerTestPreviewsRuntimeTestRuntimeTestTsFixture);

type ProviderMode =
  'success' | 'wrong' | 'stale' | 'private' | 'redirect' | 'escaped' | 'error';

function setup(mode: ProviderMode) {
  const requests: { url: string; key: string | undefined }[] = [];
  const opened: Uint8Array[] = [];
  const marked: unknown[] = [];
  const dispatch: SecureHttpTransport['dispatch'] = (request) => {
    requests.push({
      url: request.url.href,
      key: request.headers['x-widget-key'],
    });
    let status = 200;
    if (mode === 'redirect') status = 302;
    if (mode === 'error') status = 400;
    return Promise.resolve({
      status,
      headers:
        mode === 'redirect'
          ? { location: 'https://second.example.test/receiver' }
          : { 'content-type': 'application/json' },
      body: (async function* () {
        await Promise.resolve();
        yield new TextEncoder().encode(
          JSON.stringify({ result: { echo: token } }),
        );
      })(),
      close: () => undefined,
    });
  };
  const httpClient = provideHttpClient(
    new SecureHttpClient(
      {
        resolve: () =>
          Promise.resolve([
            {
              address: mode === 'private' ? '127.0.0.1' : '93.184.216.34',
              family: 4,
            },
          ]),
      },
      { dispatch },
      undefined,
      { allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32') },
    ),
  );
  const connectionId = randomUUID();
  const { node, step } = recipeNode('read', connectionId);
  const executableNode =
    mode === 'escaped'
      ? {
          ...node,
          inputMappings: {
            ...node.inputMappings,
            widget: { kind: 'literal', value: '..' },
          },
        }
      : node;
  const lease = {
    ...leaseFixture(executableNode),
    nodeId: node.id,
    definitionKey: step.definition.key,
    executorKey: step.executor.key,
    mayContactProvider: true,
  };
  const runtime: NodeExecutionRuntime = {
    workspaceId: lease.workspaceId,
    runId: lease.previewRunId,
    nodeRunId: lease.previewAttemptId,
    attemptId: lease.previewAttemptId,
    invocationKey: lease.previewAttemptId,
    attemptNumber: 1,
    nodeId: lease.nodeId,
    sideEffectClass: lease.sideEffectClass,
    beforeDispatch: (input) => {
      marked.push(input);
      return Promise.resolve();
    },
    connections: {
      resolve: () => {
        const { authType } = recipeForm();
        const secret = new TextEncoder().encode(
          JSON.stringify({ type: authType, token }),
        );
        opened.push(secret);
        return Promise.resolve({
          connectionId,
          providerKey,
          authType: mode === 'wrong' ? 'http_headers' : authType,
          secretVersionId: randomUUID(),
          secret,
        });
      },
      assertCurrent: () =>
        mode === 'stale'
          ? Promise.reject(new ProviderCredentialInvalidError())
          : Promise.resolve(),
    },
  };
  const registry = createPlatformNodeRegistry({ httpClient });
  const signal = new AbortController().signal;
  return {
    lease,
    runtime,
    registry,
    signal,
    requests,
    opened,
    marked,
    node,
    step,
  };
}

it('previews an approved read and returns only the redacted projection', async () => {
  const { registry, lease, runtime, signal, requests, opened, marked } =
    setup('success');
  const preview = createPlatformPreviewNodeInvoker({ registry });
  expect(await preview.invoke({ lease, runtime, signal })).toEqual({
    status: 'succeeded',
    output: { echo: '[Redacted]' },
  });
  expect(requests).toEqual([{ url: origin + readPath, key: token }]);
  expect(marked).toHaveLength(1);
  expect(opened[0]?.every((byte) => byte === 0)).toBe(true);
});

it.each(['wrong', 'stale', 'private', 'escaped', 'redirect'] as const)(
  'prevents a %s preview from sending credentials off the approved route',
  async (mode) => {
    const { registry, lease, runtime, signal, requests, opened, marked } =
      setup(mode);
    const preview = createPlatformPreviewNodeInvoker({ registry });
    expect(await preview.invoke({ lease, runtime, signal })).toMatchObject({
      status: 'failed',
    });
    expect(requests).toEqual(
      mode === 'redirect' ? [{ url: origin + readPath, key: token }] : [],
    );
    expect(marked).toHaveLength(mode === 'redirect' ? 1 : 0);
    if (mode === 'escaped') expect(opened).toEqual([]);
    else expect(opened[0]?.every((byte) => byte === 0)).toBe(true);
  },
);

it('retains redacted provider diagnostics on a failed recipe', async () => {
  const { registry, node, step, runtime, signal } = setup('error');
  await expect(
    registry.execute({
      definition: step.definition,
      executor: step.executor,
      config: node.config,
      input: { widget: 'North & East', count: 2 },
      connectionRefs: node.connectionRefs,
      runtime,
      signal,
    }),
  ).rejects.toMatchObject({
    serviceResponse: {
      status: 400,
      body: { kind: 'text', excerpt: '{"result":{"echo":"[Redacted]"}}' },
    },
  });
});
