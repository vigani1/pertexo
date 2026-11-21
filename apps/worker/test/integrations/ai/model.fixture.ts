import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { parseAllowedPrivateNetworks } from '@pertexo/secrets/server';
import {
  ProviderCredentialInvalidError,
  type NodeExecutionRequest,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import { createNodeProviderHttpClient } from '../../../src/providers/http-client.js';
import { createPlatformNodeRegistry } from '../../../src/providers/node-registry.js';

export const API_KEY = 'synthetic-model-api-key';
export const modelStep = { key: 'ai.model', version: 1 };
export const modelConnectionId = '742c59fe-3d20-4c3e-a0d2-0919c6785ad0';
const chatPath = '/local/v1/chat/completions';
const messagesPath = '/local/v1/messages';

export const schema = {
  type: 'object',
  properties: { count: { type: 'integer' } },
  required: ['count'],
  additionalProperties: false,
};

type Call = Readonly<{
  path: string;
  authorization: string | undefined;
  apiKey: string | string[] | undefined;
  version: string | string[] | undefined;
  request: unknown;
}>;
type Answer = (response: ServerResponse, call: Call) => void;

export const chat = (
  content: string | null,
  finish = 'stop',
  refusal?: string,
) => ({
  choices: [{ finish_reason: finish, message: { content, refusal } }],
});
export function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Answer {
  return (response) => {
    response
      .writeHead(status, { 'content-type': 'application/json', ...headers })
      .end(JSON.stringify(value));
  };
}

export async function fakeModel(answers: readonly Answer[]) {
  const calls: Call[] = [];
  let dispatches = 0;
  let currentVersion = 'version-one';
  const server = createServer((request, response) => {
    const path = request.url;
    if (
      request.method !== 'POST' ||
      (path !== chatPath && path !== messagesPath)
    ) {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      const call = {
        path,
        authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key'],
        version: request.headers['anthropic-version'],
        request: JSON.parse(body) as unknown,
      };
      const answer = answers[calls.length];
      calls.push(call);
      if (answer === undefined) response.writeHead(500).end();
      else answer(response, call);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Missing fake model server address');
  const baseUrl = `http://127.0.0.1:${String(address.port)}/local/v1/`;
  const allowed = createPlatformNodeRegistry({
    httpClient: createNodeProviderHttpClient({
      allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
    }),
  });
  const denied = createPlatformNodeRegistry();
  const connections = (
    endpoint = 'openai',
  ): NonNullable<NodeExecutionRuntime['connections']> => ({
    resolve: () =>
      Promise.resolve({
        connectionId: modelConnectionId,
        providerKey: 'ai',
        authType: 'model_api_key',
        secretVersionId: currentVersion,
        secret: Buffer.from(
          JSON.stringify({
            type: 'model_api_key',
            endpoint,
            baseUrl,
            apiKey: API_KEY,
          }),
        ),
      }),
    assertCurrent: ({ secretVersionId }) =>
      secretVersionId === currentVersion
        ? Promise.resolve()
        : Promise.reject(new ProviderCredentialInvalidError()),
  });
  return {
    calls,
    registry: allowed,
    connections,
    dispatches: () => dispatches,
    rotate: () => {
      currentVersion = 'version-two';
    },
    execute({
      endpoint = 'openai',
      config = {},
      prompt = 'mapped task',
      deadlineAt,
      signal = new AbortController().signal,
      denyAddress = false,
      observeModelUsage,
    }: Readonly<{
      endpoint?: string;
      config?: Readonly<Record<string, unknown>>;
      prompt?: string;
      deadlineAt?: Date;
      signal?: AbortSignal;
      denyAddress?: boolean;
      observeModelUsage?: NonNullable<
        NodeExecutionRuntime['observeModelUsage']
      >;
    }> = {}) {
      const invocation: NodeExecutionRequest = {
        definition: modelStep,
        executor: modelStep,
        config: { model: 'fake', mode: 'text', ...config },
        input: { prompt },
        signal,
        connectionRefs: { model_api_key: modelConnectionId },
        runtime: {
          workspaceId: 'workspace',
          nodeId: 'node',
          attemptId: 'attempt',
          nodeRunId: 'node-run',
          runId: 'run',
          invocationKey: 'invocation',
          attemptNumber: 1,
          sideEffectClass: 'safe',
          ...(deadlineAt === undefined ? {} : { deadlineAt }),
          beforeDispatch: () => {
            dispatches += 1;
            return Promise.resolve();
          },
          connections: connections(endpoint),
          ...(observeModelUsage === undefined ? {} : { observeModelUsage }),
        },
      };
      return (denyAddress ? denied : allowed).execute(invocation);
    },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
    },
  };
}
