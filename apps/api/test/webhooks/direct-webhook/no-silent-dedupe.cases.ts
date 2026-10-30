import { createHmac, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  apiQuery,
  application,
  origin,
  seedWebhook,
  sendWebhook,
  service,
} from './fixture.js';
import { browser, type Seeded } from './publish-flow.js';

/** A signed POST that carries no Idempotency-Key, as a simple sender sends it. */
async function sendWithoutKey(seeded: Seeded, body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1=${createHmac(
    'sha256',
    Buffer.from(seeded.originalSecret, 'base64url'),
  )
    .update(`${timestamp}.${body}`)
    .digest('hex')}`;
  const response = await fetch(
    new URL(`/hooks/${seeded.endpointKey}`, origin),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pertexo-timestamp': timestamp,
        'x-pertexo-signature': signature,
      },
      body,
      signal: AbortSignal.timeout(5000),
    },
  );
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

async function runCount(workspaceId: string) {
  const counted = await apiQuery<{ runs: number }>(
    `select count(*)::int runs from app.workflow_runs where workspace_id=$1`,
    [workspaceId],
  );
  return counted.rows[0]?.runs;
}

export function registerNoSilentDedupe(): void {
  // api-design-03, product-ux-16: identical bytes within five minutes return the first run.
  it.fails(
    'starts a run for each identical signed delivery that carries no key',
    async () => {
      const seeded = await seedWebhook('no-key-sequential');
      const first = await sendWithoutKey(seeded, '{"button":"pressed"}');
      const second = await sendWithoutKey(seeded, '{"button":"pressed"}');
      expect([first.status, second.status]).toEqual([202, 202]);
      expect(first.json.replayed).toBe(false);
      expect(second.json.replayed).toBe(false);
      expect(second.json.runId).not.toBe(first.json.runId);
      expect(await runCount(seeded.workspaceId)).toBe(2);
      const log = await service.listDeliveries({
        workspaceId: seeded.workspaceId,
        workflowId: seeded.workflowId,
        actorId: seeded.actorId,
        triggerId: seeded.trigger.id,
      });
      expect(log.items.map(({ outcome }) => outcome)).toEqual([
        'accepted',
        'accepted',
      ]);
    },
    60_000,
  );

  // api-design-03: concurrent identical deliveries collapse into one run.
  it.fails(
    'starts one run per delivery when identical keyless deliveries race',
    async () => {
      const seeded = await seedWebhook('no-key-concurrent');
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => sendWithoutKey(seeded, '{}')),
      );
      expect(responses.map(({ status }) => status)).toEqual(
        Array.from({ length: 5 }, () => 202),
      );
      expect(new Set(responses.map(({ json }) => json.runId)).size).toBe(5);
      expect(await runCount(seeded.workspaceId)).toBe(5);
    },
    60_000,
  );

  // api-design-03: a repeating ping with a fixed query starts one run per five minutes.
  it.fails(
    'starts a run for each identical keyless GET at a secret URL',
    async () => {
      const seeded = await seedWebhook('no-key-get');
      const { session, triggersPath } = await browser(seeded);
      const configured = await application.inject({
        method: 'POST',
        url: `${triggersPath}/${seeded.trigger.id}/webhook/authentication`,
        headers: {
          cookie: session.cookieHeader,
          'x-csrf-token': session.csrf,
          'idempotency-key': randomUUID(),
        },
        payload: { mode: 'secret_url', allowedOrigins: [] },
      });
      expect(configured.statusCode, configured.body).toBe(200);
      const { endpointKey } = configured.json<{ endpointKey: string }>();
      const ping = async () => {
        const response = await fetch(
          new URL(`/hooks/${endpointKey}?source=monitor`, origin),
          { signal: AbortSignal.timeout(5000) },
        );
        expect(response.status).toBe(202);
        return (await response.json()) as Record<string, unknown>;
      };
      const first = await ping();
      const second = await ping();
      expect(second.runId).not.toBe(first.runId);
      expect(await runCount(seeded.workspaceId)).toBe(2);
    },
    60_000,
  );

  it('still deduplicates when the sender names the event with a key', async () => {
    const seeded = await seedWebhook('explicit-key');
    const key = randomUUID();
    const body = Buffer.from('{"order":"A-17"}');
    const first = await sendWebhook(
      seeded.endpointKey,
      seeded.originalSecret,
      body,
      key,
    );
    const repeat = await sendWebhook(
      seeded.endpointKey,
      seeded.originalSecret,
      body,
      key,
    );
    expect(first.status).toBe(202);
    expect(repeat.status).toBe(202);
    expect(repeat.json).toEqual({ runId: first.json.runId, replayed: true });
    expect(await runCount(seeded.workspaceId)).toBe(1);
  }, 60_000);
}
