import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { seedWebhook } from '../fixture.js';
import {
  ADMISSION_ROW,
  deliver,
  holdRows,
  rejectedRows,
  traces,
} from './support.js';

export function registerBurstQueue(): void {
  it('lets three deliveries of a busy workspace on the database at a time, the fourth waiting off it, and accepts them all', async () => {
    const seeded = await seedWebhook(`turns-${randomUUID()}`);
    const holder = await holdRows(seeded.workspaceId);
    try {
      await holder.client.query(ADMISSION_ROW, [seeded.workspaceId]);
      const line = Array.from({ length: 4 }, () => deliver(seeded));
      await holder.waitForWaiters(3);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await holder.waiting()).toBe(3);
      await holder.finish();
      const answers = await Promise.all(line);
      expect(answers.map(({ status }) => status)).toEqual([202, 202, 202, 202]);
      expect((await traces(seeded)).runs).toBe(4);
    } finally {
      await holder.finish();
    }
  }, 60_000);

  it('answers 429 with Retry-After once the line outlasts its wait, and other workspaces keep being served', async () => {
    const other = await seedWebhook(`burst-other-${randomUUID()}`);
    const seeded = await seedWebhook(`burst-${randomUUID()}`);
    const holder = await holdRows(seeded.workspaceId);
    try {
      await holder.client.query(ADMISSION_ROW, [seeded.workspaceId]);
      // Each three at a time give up on the row at the lock timeout, so the line only
      // reaches its 20 second wait with this many in it.
      const line = Array.from({ length: 16 }, () => deliver(seeded));
      await holder.waitForWaiters(3);
      expect((await deliver(other)).status).toBe(202);
      const answers = await Promise.all(line);
      const refused = answers.filter(({ status }) => status === 429);
      const timedOut = answers.filter(({ status }) => status === 503);
      expect(refused.length).toBeGreaterThan(0);
      expect(refused.length + timedOut.length).toBe(answers.length);
      for (const answer of refused) {
        expect(answer.body).toMatchObject({ code: 'webhook.rate_limited' });
        expect(answer.headers['retry-after']).toBe('5');
      }
      for (const answer of timedOut)
        expect(Number(answer.headers['retry-after'])).toBeGreaterThan(0);
      expect((await traces(seeded)).runs).toBe(0);
      expect(
        (await rejectedRows(seeded)).filter(
          ({ outcome }) => outcome === 'rate_limited',
        ),
      ).toHaveLength(refused.length);
      await holder.finish();
      // Nothing stays stuck once the row is free.
      expect((await deliver(seeded)).status).toBe(202);
    } finally {
      await holder.finish();
    }
  }, 90_000);
}
