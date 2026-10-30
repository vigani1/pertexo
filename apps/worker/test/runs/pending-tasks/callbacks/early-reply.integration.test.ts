import { callbackResources } from './fixtures.js';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import {
  callbackTokenHash,
  createNodeSecureHttpClient,
  parseAllowedPrivateNetworks,
} from '@pertexo/integrations/server';
import {
  callbackWaitConfigSchema,
  callbackMappingExpression,
} from '@pertexo/workflow-model';
import {
  accept,
  edge,
  fixture,
  node,
  publishGraph,
  runtime,
} from '../../calls/fixtures.js';
import { startCallbackReceiver } from './receiver.js';

describe.runIf(fixture.enabled)(
  'Early callback delivery and credential non-retention',
  () => {
    beforeAll(fixture.setup, 60_000);
    afterAll(fixture.restoreServicesAndClose);
    it.each(['secret_url', 'header_secret', 'signed'] as const)(
      'delivers a real %s callback before Wait opens and redacts both sides of an echo',
      async (mode) => {
        const api = await startCallbackReceiver();
        const resources = callbackResources(api.origin);
        let received: { url: string; secret: string } | undefined;
        let receiverError: unknown;
        const destination = createServer((request, response) => {
          // Other software probes new local ports (T3 Code's desktop app sends
          // `GET /`). A probe carries no callback, so it isn't a receiver error.
          if (request.method !== 'POST') {
            response.writeHead(404).end();
            return;
          }
          void (async () => {
            const query = new URL(request.url ?? '/', 'http://127.0.0.1')
              .searchParams;
            const url = query.get('callback');
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              if (!(chunk instanceof Uint8Array))
                throw new Error('Invalid receiver bytes');
              chunks.push(Buffer.from(chunk));
            }
            const secret = Buffer.concat(chunks).toString('utf8');
            if (url === null) throw new Error('Missing outbound callback URL');
            const supplied = new URL(url);
            const token = /^\/hooks\/([A-Za-z0-9_-]{43})\/resume$/u.exec(
              supplied.pathname,
            )?.[1];
            if (
              supplied.origin !== api.origin ||
              token === undefined ||
              supplied.search ||
              supplied.hash
            )
              throw new Error('Callback must target the owned API receiver');
            const target = new URL(api.origin);
            target.pathname = `/hooks/${token}/resume`;
            received = { url, secret };
            const body = JSON.stringify({
              amount: 17,
              echo: url,
              credential: secret,
            });
            const timestamp = String(Math.floor(Date.now() / 1000));
            let authentication;
            if (mode === 'header_secret') {
              authentication = { authorization: `Bearer ${secret}` };
            } else if (mode === 'signed') {
              authentication = {
                'x-pertexo-timestamp': timestamp,
                'x-pertexo-signature': `v1=${createHmac('sha256', Buffer.from(secret, 'base64url')).update(`${timestamp}.`).update(body).digest('hex')}`,
              };
            } else {
              authentication = {};
            }
            const reply = await fetch(target, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...authentication,
              },
              body,
            });
            expect(reply.status).toBe(202);
            expect(
              await fixture.workerQuery(
                'select node_run_id,status from app.pending_run_tasks where callback_token_hash=$1',
                [callbackTokenHash(token)],
              ),
            ).toEqual([{ node_run_id: null, status: 'submitted' }]);
            response.writeHead(200, {
              'content-type': 'application/json',
              'x-callback-echo': url,
            });
            response.end(body);
          })().catch((error: unknown) => {
            receiverError = error;
            response.writeHead(500);
            response.end();
          });
        });
        destination.listen(0, '127.0.0.1');
        await once(destination, 'listening');
        const address = destination.address();
        if (address === null || typeof address === 'string')
          throw new Error('No receiver address');
        const version = await publishGraph({
          settings: { maxRunDurationMs: 60_000 },
          nodes: [
            node('manual', 'core.manual'),
            {
              ...node('send', 'http.request'),
              config: {
                method: 'POST',
                url: `http://127.0.0.1:${String(address.port)}/?callback={callbackUrl}`,
                headers: {},
                timeoutMillis: 5000,
                maxRedirects: 0,
                maxResponseBytes: 4096,
                inlineResponseBytes: 4096,
              },
              inputMappings: {
                callbackUrl: {
                  kind: 'expression',
                  language: 'jsonata',
                  expression: callbackMappingExpression('wait', 'url'),
                },
                ...(mode === 'secret_url'
                  ? {}
                  : {
                      body: {
                        kind: 'expression',
                        language: 'jsonata',
                        expression: `{"encoding":"utf8","value":${callbackMappingExpression('wait', 'secret')}}`,
                      },
                    }),
              },
            },
            {
              ...node('wait', 'core.wait'),
              config: callbackWaitConfigSchema.parse({
                mode: 'callback',
                timeoutSeconds: 60,
                authentication:
                  mode === 'header_secret'
                    ? { mode, headerName: 'authorization', allowedOrigins: [] }
                    : { mode, allowedOrigins: [] },
              }),
            },
            {
              ...node('done', 'core.terminate'),
              inputMappings: {
                result: {
                  kind: 'node_output',
                  nodeId: 'wait',
                  path: '$.body.amount',
                },
              },
            },
          ],
          edges: [
            edge('manual', 'send'),
            edge('send', 'wait'),
            edge('wait', 'done'),
          ],
        });
        const run = await accept(version);
        const workers = await runtime(
          createPlatformNodeRegistry({
            httpRequest: {
              httpClient: createNodeSecureHttpClient({
                allowedPrivateNetworks:
                  parseAllowedPrivateNetworks('127.0.0.1/32'),
              }),
            },
          }),
          resources.capabilities,
        );
        try {
          await workers.until(async () => {
            expect(receiverError).toBeUndefined();
            const failures = await fixture.workerQuery(
              "select node_id,safe_error_code from app.node_runs where workflow_run_id=$1 and status in ('failed','outcome_unknown')",
              [run.runId],
            );
            expect(failures).toEqual([]);
            expect(
              await fixture.workerQuery(
                'select node_id,status,safe_error_code from app.node_runs where workflow_run_id=$1 order by node_id',
                [run.runId],
              ),
            ).toContainEqual({
              node_id: 'done',
              status: 'succeeded',
              safe_error_code: null,
            });
          });
          if (received === undefined)
            throw new Error('The HTTP step never sent its callback');
          const persisted = JSON.stringify(
            await fixture.workerQuery(
              'select node_id,input_ref,output_ref from app.node_runs where workflow_run_id=$1',
              [run.runId],
            ),
          );
          expect(persisted).not.toContain(
            new URL(received.url).pathname.split('/')[2],
          );
          if (mode !== 'secret_url')
            expect(persisted).not.toContain(received.secret);
          expect(
            await fixture.workerQuery(
              "select input_ref from app.node_runs where workflow_run_id=$1 and node_id='send'",
              [run.runId],
            ),
          ).toEqual([{ input_ref: null }]);
          expect(
            await fixture.workerQuery(
              "select output_ref from app.node_runs where workflow_run_id=$1 and node_id='done'",
              [run.runId],
            ),
          ).toEqual([
            { output_ref: { kind: 'inline', value: { result: 17 } } },
          ]);
          expect(
            await fixture.workerQuery(
              "select count(*)::int n from app.run_events where workflow_run_id=$1 and payload->>'reasonCode'='callback.received'",
              [run.runId],
            ),
          ).toEqual([{ n: 1 }]);
        } finally {
          await workers.close();
          destination.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            destination.close((error) => {
              if (error === undefined) resolve();
              else reject(error);
            });
          });
          await api.close();
          await resources.close();
        }
      },
      30_000,
    );
  },
);
