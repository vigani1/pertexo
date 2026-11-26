import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { afterAll, beforeAll, expect } from 'vitest';
import {
  connectionResponseSchema,
  draftProposalResultSchema,
  workflowCreateResponseSchema,
} from '@pertexo/contracts';
import {
  ConnectionEnvelopeEncryption,
  parseAllowedPrivateNetworks,
  type ConnectionSecretContext,
} from '@pertexo/secrets/server';
import { createEditorBrowserEnvelopeKeys } from '../../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import { createNodeProviderHttpClient } from '../../../src/platform/connections/http-client.js';
import {
  useBetterAuthRealApi,
  type Browser,
} from '../../support/better-auth/real-api.support.js';

export const credentialSentinel = 'proposal-credential-sentinel';

/** One scripted answer from the local model. */
export interface ProposalReply {
  graph: unknown;
  text?: string;
  outputTokens?: number;
  /** `length` is a reply the model cut off at its output limit. */
  finishReason?: 'stop' | 'length';
  waitMillis?: number;
  hold?: boolean;
}

/**
 * A real API with a local model the test scripts, and the calls a proposal
 * test makes against it. Call it inside the suite's describe.
 */
export function useProposalApi(name: string) {
  const keys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
    randomBytes(32),
    'connection',
  );
  const http = createNodeProviderHttpClient({
    allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
  });
  const api = useBetterAuthRealApi(name, {
    codeSettings: { ...DEFAULT_CODE_SETTINGS, enabled: false },
    connections: {
      config: { kmsKeyReference: 'local-inference', region: 'us-east-1' },
      services: () => ({
        encryption: { encryption: new ConnectionEnvelopeEncryption(keys) },
        http,
      }),
    },
  });
  const requests: string[] = [];
  let replies: ProposalReply[] = [];
  const inference = createServer((request, response) => {
    request.setEncoding('utf8');
    let body = '';
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push(body);
      const reply = replies.shift();
      if (
        request.headers.authorization !== `Bearer ${credentialSentinel}` ||
        reply === undefined
      ) {
        response.writeHead(401).end();
        return;
      }
      if (reply.hold) return;
      const { graph, text, outputTokens = 10, finishReason = 'stop' } = reply;
      if (reply.waitMillis === undefined) {
        sendReply();
      } else {
        const timer = setTimeout(sendReply, reply.waitMillis);
        response.once('close', () => {
          clearTimeout(timer);
        });
      }

      function sendReply() {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: finishReason,
                message: { content: text ?? JSON.stringify({ draft: graph }) },
              },
            ],
            usage: {
              prompt_tokens: 40,
              completion_tokens: outputTokens,
            },
          }),
        );
      }
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      inference.listen(0, '127.0.0.1', resolve),
    );
  });

  afterAll(async () => {
    keys.close();
    inference.closeAllConnections();
    await new Promise<void>((resolve) =>
      inference.close(() => {
        resolve();
      }),
    );
  });

  async function workspaceFor(browser: Browser) {
    const root = await api.send('POST', '/v1/workspaces', {
      browser,
      headers: key(),
      payload: {
        name: 'Draft proposals',
        slug: `proposals-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(root.statusCode, root.payload).toBe(201);
    const { id } = root.json<{ id: string }>();
    const path = `/v1/workspaces/${id}`;
    const address = inference.address();
    if (address === null || typeof address === 'string')
      throw new Error('Inference listener unavailable');
    const connection = await api.send('POST', `${path}/connections`, {
      browser,
      headers: key(),
      payload: {
        providerKey: 'ai',
        name: 'Local model',
        credential: {
          type: 'model_api_key',
          endpoint: 'vllm',
          baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
          apiKey: credentialSentinel,
        },
      },
    });
    expect(connection.statusCode, connection.payload).toBe(201);
    const { id: connectionId } = connectionResponseSchema.parse(
      connection.json(),
    );
    await api
      .database()
      .query(
        "update app.connections set access_mode='restricted' where workspace_id=$1 and id=$2",
        [id, connectionId],
      );
    const saved = await api.send('PUT', `${path}/assistant`, {
      browser,
      payload: { selection: { connectionId, model: 'local-test' } },
    });
    expect(saved.json()).toMatchObject({ kind: 'saved' });
    return { path, id };
  }

  async function newUser() {
    const email = `proposal-${randomUUID()}@example.test`;
    await api.signUp(email, '/workspaces');
    const browser = await api.signIn(email);
    const user = await api.send('GET', '/v1/users/me', { browser });
    return { browser, id: user.json<{ id: string }>().id };
  }

  async function workflow(path: string, browser: Browser) {
    const result = await api.send('POST', `${path}/workflows`, {
      browser,
      headers: key(),
      payload: { name: 'Order intake' },
    });
    expect(result.statusCode, result.payload).toBe(201);
    return `${path}/workflows/${workflowCreateResponseSchema.parse(result.json()).workflow.id}`;
  }

  function draft(path: string, browser: Browser) {
    return api.send('GET', `${path}/draft`, { browser });
  }

  function save(path: string, etag: unknown, graph: unknown, browser: Browser) {
    expect(typeof etag).toBe('string');
    return api.send('PUT', `${path}/draft`, {
      browser,
      headers: { 'If-Match': String(etag) },
      payload: { graph },
    });
  }

  async function usageRows(path: string) {
    const retained = await api
      .database()
      .query<{ metadata: unknown }>(
        "select metadata from app.usage_events where resource_id=$1 and category='assistant.model'",
        [path.split('/').at(-1)],
      );
    return retained.rows.map(({ metadata }) => metadata);
  }

  async function propose(
    path: string,
    script: ProposalReply[],
    browser: Browser,
    request = 'Start with a manual trigger and add an HTTP request.',
  ) {
    replies = script;
    const endpoint = `${path}/draft/proposal`;
    const disclosure = await api.send('GET', endpoint, { browser });
    expect(disclosure.statusCode, disclosure.payload).toBe(200);
    const { confirmation } = disclosure.json<{ confirmation: string }>();
    const result = await api.send('POST', endpoint, {
      browser,
      payload: {
        confirmation,
        request,
      },
    });
    expect(result.statusCode, result.payload).toBe(200);
    return draftProposalResultSchema.parse(result.json());
  }

  return {
    api,
    requests,
    newUser,
    workspaceFor,
    workflow,
    draft,
    save,
    usageRows,
    propose,
  };
}

function key() {
  return { 'Idempotency-Key': randomUUID() };
}
