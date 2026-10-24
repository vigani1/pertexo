import { createServer, type ServerResponse } from 'node:http';

import { z } from 'zod';

import type {
  ConnectionHealthFixtureOptions,
  ConnectionHealthFixtureState,
  ConnectionHealthApi,
} from './contract.js';

export function createConnectionHealthControl(
  input: Readonly<{
    state: ConnectionHealthFixtureState;
    held: Set<ServerResponse>;
    pending: Set<Promise<void>>;
    json: (response: ServerResponse, value: unknown) => void;
    options: ConnectionHealthFixtureOptions;
    commandFor: (path: string) => Promise<unknown>;
    readApi: () => ConnectionHealthApi;
    token: string;
    replacementToken: string;
  }>,
) {
  const {
    state,
    held,
    pending,
    json,
    options,
    commandFor,
    readApi,
    token,
    replacementToken,
  } = input;
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/api/auth.test') {
      json(response, { ok: true });
      return;
    }
    if (path === '/api/chat.postMessage') {
      state.sends++;
      const action = state.nextResponse;
      state.nextResponse = 'reject';
      if (action === 'hold') {
        held.add(response);
        response.once('close', () => held.delete(response));
        return;
      }
      json(
        response,
        action === 'healthy'
          ? { ok: true, channel: 'C123ABC', ts: '1710000000.000001' }
          : { ok: false, error: 'token_revoked' },
      );
      return;
    }
    if (request.method === 'GET' && path === '/connection-health-seed') {
      json(response, {
        workspaceId: state.workspaceId,
        connectionId: state.connectionId,
        workflowId: state.workflowId,
        token,
        replacementToken,
        cookies: [
          {
            name: 'pertexo_session',
            value: state.browser.session,
            url: options.webOrigin,
          },
          {
            name: 'pertexo_csrf',
            value: encodeURIComponent(state.browser.csrf),
            url: options.webOrigin,
          },
        ],
      });
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    if (path === '/browser-opened' || path === '/browser-disposed') {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 512) request.destroy();
      });
      request.on('end', () => {
        try {
          const parsed = z
            .object({ instanceId: z.uuid() })
            .strict()
            .parse(JSON.parse(body));
          options.browserLifetime?.(path, parsed.instanceId);
          response.writeHead(204).end();
        } catch {
          response.writeHead(400).end();
        }
      });
      return;
    }
    const command = Promise.resolve()
      .then(() => commandFor(path))
      .then(
        (value) => {
          json(response, value);
        },
        async () => {
          const runs = await readApi()
            .database()
            .query<{ status: string }>(
              'select status from app.workflow_runs where workspace_id=$1',
              [state.workspaceId],
            );
          const attempts = await readApi()
            .database()
            .query<{ status: string }>(
              'select status from app.node_attempts where workspace_id=$1',
              [state.workspaceId],
            );
          const outbox = await readApi()
            .database()
            .query<{ job_name: string; published: boolean; failed: boolean }>(
              'select job_name,published_at is not null published,failed_at is not null failed from app.outbox_events where workspace_id=$1',
              [state.workspaceId],
            );
          console.info(
            'Owned health command diagnostics',
            JSON.stringify({
              stage: state.commandStage,
              providerCalls: state.sends,
              runs: runs.rows,
              attempts: attempts.rows,
              outbox: outbox.rows,
            }),
          );
          response
            .writeHead(500)
            .end('Owned connection health evidence failed');
        },
      );
    pending.add(command);
    void command.finally(() => pending.delete(command));
  });
}
