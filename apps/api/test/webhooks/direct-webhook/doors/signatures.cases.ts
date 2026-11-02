import { randomBytes, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { seedWebhook, service } from '../fixture.js';
import {
  comparable,
  deliver,
  inWorkspace,
  nowSeconds,
  rejectedRows,
  send,
  signatureOf,
  traces,
} from './support.js';

export function registerSignatures(): void {
  it('refuses a signature that is wrong, old, from the future, missing or for other bytes', async () => {
    const seeded = await seedWebhook(`signature-${randomUUID()}`);
    const key = seeded.endpointKey;
    const secret = seeded.originalSecret;
    const before = await traces(seeded);
    const timestamp = String(nowSeconds());
    const attempts: readonly (readonly [string, Parameters<typeof send>[1]])[] =
      [
        ['no proof at all', {}],
        ['a wrong secret', { secret: randomBytes(32).toString('base64url') }],
        [
          'a captured request from an hour ago',
          {
            secret,
            timestamp: String(nowSeconds() - 3_600),
          },
        ],
        [
          'one just past the five minute allowance',
          {
            secret,
            timestamp: String(nowSeconds() - 310),
          },
        ],
        [
          'a timestamp from the future',
          {
            secret,
            timestamp: String(nowSeconds() + 3_600),
          },
        ],
        [
          'a signature without its timestamp',
          {
            headers: {
              'x-pertexo-signature': signatureOf(secret, timestamp, '{}'),
            },
          },
        ],
        [
          'a timestamp without its signature',
          {
            headers: { 'x-pertexo-timestamp': timestamp },
          },
        ],
        [
          'a signature over other bytes',
          {
            body: '{"amount":1000000}',
            headers: {
              'x-pertexo-timestamp': timestamp,
              'x-pertexo-signature': signatureOf(secret, timestamp, '{}'),
            },
          },
        ],
        [
          'a signature in the wrong scheme',
          {
            headers: {
              'x-pertexo-timestamp': timestamp,
              'x-pertexo-signature': signatureOf(
                secret,
                timestamp,
                '{}',
              ).replace('v1=', 'v0='),
            },
          },
        ],
      ];
    const reference = comparable(await send(key, {}));
    expect(reference.status).toBe(401);
    for (const [name, attempt] of attempts) {
      const answered = comparable(await send(key, attempt));
      expect(answered, name).toEqual(reference);
    }
    const after = await traces(seeded);
    expect(after.runs).toBe(before.runs);
    expect(after.accepted).toBe(before.accepted);
    expect(
      (await rejectedRows(seeded)).map(({ http_status }) => http_status),
    ).toEqual(Array.from({ length: attempts.length + 1 }, () => 401));
  }, 60_000);

  it('answers a replayed request once: same key returns the first run, other bytes conflict', async () => {
    const seeded = await seedWebhook(`replay-${randomUUID()}`);
    const idempotencyKey = randomUUID();
    const first = await send(seeded.endpointKey, {
      secret: seeded.originalSecret,
      idempotencyKey,
    });
    expect(first.status).toBe(202);
    const replayed = await send(seeded.endpointKey, {
      secret: seeded.originalSecret,
      idempotencyKey,
    });
    expect(replayed.status).toBe(202);
    expect(replayed.body).toMatchObject({
      runId: first.body.runId,
      replayed: true,
    });
    const changed = await send(seeded.endpointKey, {
      secret: seeded.originalSecret,
      idempotencyKey,
      body: '{"other":true}',
    });
    expect(changed.status).toBe(409);
    expect((await traces(seeded)).runs).toBe(1);
  }, 60_000);

  it('takes the previous secret inside its window and not a moment after', async () => {
    const seeded = await seedWebhook(`window-${randomUUID()}`);
    const rotated = await service.rotateSecret({
      workspaceId: seeded.workspaceId,
      workflowId: seeded.workflowId,
      actorId: seeded.actorId,
      triggerId: seeded.trigger.id,
      endpointKey: seeded.endpointKey,
      idempotencyKey: randomUUID(),
    });
    const next = rotated.signingSecret;
    if (next === undefined) throw new Error('Expected the next secret');
    expect((await deliver(seeded)).status).toBe(202);
    await inWorkspace(
      seeded.workspaceId,
      `update app.webhook_trigger_endpoints
          set previous_secret_valid_until=clock_timestamp()-interval '1 millisecond'
        where workflow_id=$1`,
      [seeded.workflowId],
    );
    const before = await traces(seeded);
    expect((await deliver(seeded)).status).toBe(401);
    expect((await traces(seeded)).runs).toBe(before.runs);
    expect((await send(seeded.endpointKey, { secret: next })).status).toBe(202);
  }, 60_000);
}
