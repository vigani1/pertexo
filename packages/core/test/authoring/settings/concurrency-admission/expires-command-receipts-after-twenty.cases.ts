import { createHash, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { workspaceA } from '../../../runs/acceptance/fixtures.js';
import {
  reapConcurrencyReceipts,
  withConcurrencyControls,
  withOwner,
} from '../concurrency-admission.fixtures.js';

export function registerExpiresCommandReceiptsAfterTwenty(): void {
  it('expires command receipts after twenty-four hours and reaps only expired rows in bounded existing retention', async () => {
    await withConcurrencyControls(async (controls, scope) => {
      const expiredKey = randomUUID(),
        retainedKey = randomUUID();
      const expiredHash = createHash('sha256').update(expiredKey).digest('hex');
      const retainedHash = createHash('sha256')
        .update(retainedKey)
        .digest('hex');
      await controls.updateSettings({
        ...scope,
        limit: 1,
        expectedRevision: 1,
        idempotencyKey: expiredKey,
      });
      await controls.updateSettings({
        ...scope,
        limit: 2,
        expectedRevision: 2,
        idempotencyKey: retainedKey,
      });
      await withOwner(async (client) => {
        const expiries = await client.query<{ seconds: number }>(
          `select extract(epoch from(expires_at-clock_timestamp()))::float8 seconds
           from app.idempotency_records where workspace_id=$1 and operation='workflow.concurrency' and key_hash=any($2::text[])`,
          [workspaceA, [expiredHash, retainedHash]],
        );
        expect(expiries.rows).toHaveLength(2);
        for (const { seconds } of expiries.rows)
          expect(seconds).toBeGreaterThan(86_390);
        await client.query(
          `update app.idempotency_records
          set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second'
          where workspace_id=$1 and operation='workflow.concurrency' and key_hash=$2`,
          [workspaceA, expiredHash],
        );
      });
      expect(await reapConcurrencyReceipts()).toBe(1);
      expect(
        await withOwner(
          async (client) =>
            (
              await client.query<{ key_hash: string }>(
                "select key_hash from app.idempotency_records where workspace_id=$1 and operation='workflow.concurrency' and key_hash=any($2::text[])",
                [workspaceA, [expiredHash, retainedHash]],
              )
            ).rows,
        ),
      ).toEqual([{ key_hash: retainedHash }]);
      await expect(
        controls.updateSettings({
          ...scope,
          limit: 1,
          expectedRevision: 1,
          idempotencyKey: expiredKey,
        }),
      ).rejects.toMatchObject({
        name: 'WorkflowConcurrencyRevisionConflictError',
        currentRevision: 3,
      });
    });
  });
}
