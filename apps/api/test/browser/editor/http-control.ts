import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { z } from 'zod';
import { sendBoundedWebhook } from '../../webhooks/bounded-webhook-client.js';
import { createEditorWebhookLossProxy } from './webhook-loss-proxy.js';
import {
  httpActionBody,
  httpEvidenceSchema,
  httpScopeSchema,
  verifyHttpAccepted,
  verifyHttpEndpoint,
} from './evidence/http.js';

const invocationSchema = httpScopeSchema.extend({
  endpointKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  signingSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});

/** Private loopback fixture controls, never registered in the application API. */
export function createEditorHttpControl(
  database: () => Pool,
  authorizationValue: string,
  assertActive: () => void,
) {
  let apiOrigin: string | undefined;
  let proxy: ReturnType<typeof createEditorWebhookLossProxy> | undefined;
  let used = false;
  let stopped = false;
  let evidence: z.infer<typeof httpEvidenceSchema> | undefined;
  let accepted:
    | {
        trueRunId: string;
        falseRunId: string;
        senderKey: string;
        falseKey: string;
      }
    | undefined;
  function active() {
    assertActive();
    if (stopped) throw new Error('Owned HTTP control disposed');
  }
  async function body(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      bytes += chunk.length;
      if (bytes > 4096) throw new Error('Owned HTTP control body too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  return {
    setApiOrigin(origin: string) {
      if (apiOrigin !== undefined)
        throw new Error('Owned HTTP API already selected');
      apiOrigin = origin;
    },
    readEvidence() {
      if (evidence === undefined || accepted === undefined)
        throw new Error('Owned HTTP evidence missing');
      for (const field of [
        'trueRunId',
        'falseRunId',
        'senderKey',
        'falseKey',
      ] as const)
        if (evidence[field] !== accepted[field])
          throw new Error('Owned HTTP evidence does not match sender receipts');
      return evidence;
    },
    handle(request: IncomingMessage, response: ServerResponse): boolean {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (
        !['/http-credential', '/http-invoke', '/evidence/http'].includes(path)
      )
        return false;
      void (async () => {
        try {
          active();
          if (path === '/http-credential' && request.method === 'GET') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ authorizationValue }));
            return;
          }
          if (request.method !== 'POST')
            throw new Error('Owned HTTP control method invalid');
          if (path === '/evidence/http') {
            if (evidence !== undefined || accepted === undefined)
              throw new Error('Owned HTTP evidence not expected');
            evidence = httpEvidenceSchema.parse(await body(request));
            active();
            response.writeHead(204).end();
            return;
          }
          if (path !== '/http-invoke')
            throw new Error('Owned HTTP control path invalid');
          if (used || apiOrigin === undefined)
            throw new Error('Owned HTTP invocation not available');
          used = true; // Own setup across awaits, not merely during HTTP dispatch.
          const input = invocationSchema.parse(await body(request));
          await verifyHttpEndpoint(database(), input, input.endpointKey);
          active();
          proxy = createEditorWebhookLossProxy(
            apiOrigin,
            input.endpointKey,
            async (id) => {
              await verifyHttpAccepted(database(), input, id);
              active();
            },
          );
          await proxy.start();
          active();
          const origin = proxy.origin();
          const senderKey = randomUUID(),
            falseKey = randomUUID();
          const rawBody = Buffer.from(
            JSON.stringify({
              execute: true,
              body: { encoding: 'utf8', value: httpActionBody },
            }),
          );
          const sender = {
            origin,
            endpointKey: input.endpointKey,
            secret: input.signingSecret,
            rawBody,
            idempotencyKey: senderKey,
          };
          let lost = false;
          try {
            await sendBoundedWebhook(sender);
          } catch {
            lost = true;
          }
          active();
          const observation = proxy.observe();
          if (
            !lost ||
            observation.lostRunId === undefined ||
            observation.firstTimestamp === undefined
          )
            throw new Error('Committed ingress acknowledgement was not lost');
          // Actual clock: the new signature timestamp must be fresh, not fabricated.
          const waitStarted = Date.now();
          while (
            String(Math.floor(Date.now() / 1000)) === observation.firstTimestamp
          ) {
            if (Date.now() - waitStarted > 2000)
              throw new Error('Owned sender clock did not advance');
            await delay(25);
            active();
          }
          const retry = await sendBoundedWebhook(sender);
          active();
          if (
            retry.status !== 202 ||
            retry.json.runId !== observation.lostRunId ||
            retry.json.replayed !== true ||
            retry.requestMaterial.timestamp === observation.firstTimestamp
          )
            throw new Error('Exact signed ingress replay failed');
          const conflict = await sendBoundedWebhook({
            ...sender,
            rawBody: Buffer.from(
              JSON.stringify({ execute: true, changed: true }),
            ),
          });
          active();
          if (conflict.status !== 409)
            throw new Error('Changed signed intent did not conflict');
          const second = await sendBoundedWebhook({
            ...sender,
            idempotencyKey: falseKey,
            rawBody: Buffer.from(
              JSON.stringify({
                execute: false,
                body: { encoding: 'utf8', value: httpActionBody },
              }),
            ),
          });
          active();
          const falseRunId = z.uuid().parse(second.json.runId);
          if (
            second.status !== 202 ||
            second.json.replayed !== false ||
            falseRunId === observation.lostRunId
          )
            throw new Error('False branch not independently accepted');
          accepted = {
            trueRunId: observation.lostRunId,
            falseRunId,
            senderKey,
            falseKey,
          };
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(accepted));
        } catch {
          // Never reflect parse inputs, credentials, nested transport or SQL errors.
          if (!response.destroyed) response.writeHead(400).end();
        }
      })();
      return true;
    },
    async close() {
      stopped = true;
      await proxy?.close();
    },
  };
}
