import { randomUUID } from 'node:crypto';
import {
  ProviderCredentialInvalidError,
  type NodeExecutionRequest,
} from '@pertexo/node-sdk/server';
import { parseAllowedPrivateNetworks } from '@pertexo/secrets/server';
import { expect, it } from 'vitest';
import { createNodeProviderHttpClient } from '../../../src/providers/http-client.js';
import { createPlatformNodeRegistry } from '../../../src/providers/node-registry.js';
import { fakeMcp, MCP_TOKEN, reply, TOOL_INPUT } from './server.fixture.js';

const definition = { key: 'mcp.call_tool', version: 1 };
const connectionId = randomUUID();
const allowed = createPlatformNodeRegistry({
  httpClient: createNodeProviderHttpClient({
    allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
  }),
});
const denied = createPlatformNodeRegistry();

function execute(
  endpoint: string,
  {
    denyAddress = false,
    current = () => true,
  }: Readonly<{ denyAddress?: boolean; current?: () => boolean }> = {},
) {
  const request: NodeExecutionRequest = {
    definition,
    executor: definition,
    config: { toolName: 'counter', toolInputSchema: TOOL_INPUT },
    input: { count: 42 },
    connectionRefs: { mcp_bearer: connectionId },
    signal: new AbortController().signal,
    runtime: {
      workspaceId: 'workspace',
      nodeId: 'node',
      attemptId: 'attempt',
      nodeRunId: 'node-run',
      runId: 'run',
      invocationKey: 'invocation',
      attemptNumber: 1,
      sideEffectClass: 'unsafe',
      beforeDispatch: () => Promise.resolve(),
      connections: {
        resolve: () =>
          Promise.resolve({
            connectionId,
            providerKey: 'mcp',
            authType: 'mcp_bearer',
            secretVersionId: 'first',
            secret: Buffer.from(
              JSON.stringify({
                type: 'mcp_bearer',
                endpoint,
                token: MCP_TOKEN,
              }),
            ),
          }),
        assertCurrent: () =>
          current()
            ? Promise.resolve()
            : Promise.reject(new ProviderCredentialInvalidError()),
      },
    },
  };
  return (denyAddress ? denied : allowed).execute(request);
}

it('maps arguments and reads a complete POST event before the provider closes its stream', async () => {
  await using fake = await fakeMcp();
  expect(await execute(fake.url)).toEqual({
    kind: 'succeeded',
    output: { kind: 'structured', data: { count: 42 } },
  });
  expect(fake.calls.map(({ method }) => method)).toEqual([
    'initialize',
    'notifications/initialized',
    'tools/list',
    'tools/call',
  ]);
  expect(fake.calls.at(-1)?.params).toEqual({
    name: 'counter',
    arguments: { count: 42 },
  });
});

it('refuses disallowed addresses before contacting the provider', async () => {
  await using fake = await fakeMcp();
  await expect(execute(fake.url, { denyAddress: true })).rejects.toMatchObject({
    safeErrorCode: 'mcp.address_denied',
    possiblyDispatched: false,
  });
  expect(fake.calls).toEqual([]);
});

it('does not follow provider redirects', async () => {
  await using target = await fakeMcp();
  await using fake = await fakeMcp({
    initialize: (response) => {
      response.writeHead(307, { location: target.url }).end();
    },
  });
  await expect(execute(fake.url)).rejects.toMatchObject({
    safeErrorCode: 'mcp.address_denied',
    possiblyDispatched: false,
  });
  expect(target.calls).toEqual([]);
});

it.each([
  { name: 'malformed', body: '{', code: 'invalid_response' },
  {
    name: 'oversized',
    body: 'x'.repeat(512 * 1_024),
    code: 'response_too_large',
  },
])('refuses a $name discovery response', async ({ body, code }) => {
  await using fake = await fakeMcp({
    'tools/list': (response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(body);
    },
  });
  await expect(execute(fake.url)).rejects.toMatchObject({
    safeErrorCode: `mcp.${code}`,
    possiblyDispatched: false,
  });
  expect(fake.calls.map(({ method }) => method)).not.toContain('tools/call');
});

it.each([
  {
    inputSchema: { type: 'object', $ref: '#/$defs/foo' },
    code: 'schema_unsupported',
  },
  {
    inputSchema: TOOL_INPUT,
    outputSchema: { type: 'object', $ref: '#/$defs/foo' },
    code: 'schema_unsupported',
  },
  {
    inputSchema: { ...TOOL_INPUT, properties: { count: { type: 'string' } } },
    code: 'schema_changed',
  },
])(
  'refuses discovery with $code before calling the tool',
  async ({ inputSchema, outputSchema, code }) => {
    await using fake = await fakeMcp({
      'tools/list': (response, request) => {
        reply(response, request, {
          tools: [{ name: 'counter', inputSchema, outputSchema }],
        });
      },
    });
    await expect(execute(fake.url)).rejects.toMatchObject({
      safeErrorCode: `mcp.${code}`,
      possiblyDispatched: false,
    });
    expect(fake.calls.map(({ method }) => method)).not.toContain('tools/call');
  },
);

it('refuses to dispatch after discovery when the connection changed', async () => {
  await using fake = await fakeMcp();
  await expect(
    execute(fake.url, {
      current: () => !fake.calls.some(({ method }) => method === 'tools/list'),
    }),
  ).rejects.toMatchObject({
    safeErrorCode: 'mcp.credential_rejected',
    possiblyDispatched: false,
  });
  expect(fake.calls.map(({ method }) => method)).not.toContain('tools/call');
});

it('preserves an uncertain outcome when the server accepts the tool call then disconnects', async () => {
  await using fake = await fakeMcp({
    'tools/call': (response) => {
      response.destroy();
    },
  });
  await expect(execute(fake.url)).rejects.toMatchObject({
    kind: 'outcome_unknown',
    possiblyDispatched: true,
  });
  expect(
    fake.calls.filter(({ method }) => method === 'tools/call'),
  ).toHaveLength(1);
});
