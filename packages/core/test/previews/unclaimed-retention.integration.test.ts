import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createPreviewRetentionCoordinator } from '../../src/lifecycle/previews/coordinator.js';
import { settleOverdueDeliveries } from '../../src/outbox/overdue-deliveries.repository.js';
import { claimPreviewDelivery } from '../../src/previews/attempts/claim.js';
import { isStoredDataError } from '../../src/shared/stored-values.js';
import {
  acceptFixture,
  databaseUrl,
  maintenanceBaseUrl,
  withAdmin,
  workspaceId,
  scopedQuery,
  workerPool,
  previewTerminalFacts,
} from './worker.fixture.js';

async function waitUntil(date: Date) {
  await expect
    .poll(
      async () =>
        (
          await scopedQuery<{ reached: boolean }>(
            'select clock_timestamp()>=$1::timestamptz reached',
            [date],
          )
        ).rows[0]?.reached,
      { timeout: 6_000, interval: 20 },
    )
    .toBe(true);
}

function coordinator() {
  return createPreviewRetentionCoordinator(
    parseDatabaseConfig({
      connectionString: databaseUrl(maintenanceBaseUrl),
      max: 2,
    }),
    { delete: () => Promise.resolve(), head: () => Promise.resolve(null) },
  );
}

describe('eventual cleanup without a successful first preview claim', () => {
  it.each(['lost first delivery', 'unreadable saved input'] as const)(
    'terminalizes and cleans up after %s, across coordinator restarts',
    async (scenario) => {
      const executionDeadlineAt = new Date(Date.now() + 1_500);
      const expiresAt = new Date(Date.now() + 3_000);
      const preview = await acceptFixture({ executionDeadlineAt, expiresAt });
      if (scenario === 'unreadable saved input') {
        await withAdmin((db) =>
          db.query(
            "update app.preview_runs set input_ref='{}'::jsonb where id=$1",
            [preview.previewRunId],
          ),
        );
        await expect(
          claimPreviewDelivery(workerPool, {
            ...preview,
            workspaceId,
            workerId: 'poison-first-claim',
            leaseDurationSeconds: 30,
          }),
        ).rejects.toSatisfy(isStoredDataError);
      }
      const maintenance = new Pool({
        connectionString: databaseUrl(maintenanceBaseUrl),
        max: 1,
      });
      try {
        await withAdmin((db) =>
          db.query(
            `update app.outbox_events set published_at=clock_timestamp(), delivery_due_at=clock_timestamp()-interval '1 second',redeliveries=30 where id=$1`,
            [preview.outboxEventId],
          ),
        );
        const settled = await settleOverdueDeliveries(maintenance, 10);
        expect(settled.asked).toContainEqual(
          expect.objectContaining({
            outboxEventId: preview.outboxEventId,
            gaveUp: true,
          }),
        );
      } finally {
        await maintenance.end();
      }
      const first = coordinator();
      try {
        expect(await first.processNext()).toEqual({ status: 'idle' });
        await waitUntil(executionDeadlineAt);
        expect(await first.processNext()).toMatchObject({
          status: 'progressed',
          previewRunId: preview.previewRunId,
        });
      } finally {
        await first.close();
      }
      const status =
        scenario === 'lost first delivery' ? 'timed_out' : 'failed';
      const code =
        scenario === 'lost first delivery'
          ? 'preview.deadline_exceeded'
          : 'preview.stored_data_invalid';
      expect(
        (
          await scopedQuery<{
            status: string;
            safe_error_code: string;
            completed: boolean;
          }>(
            `select status,safe_error_code,completed_at is not null completed from app.preview_runs where id=$1`,
            [preview.previewRunId],
          )
        ).rows,
      ).toEqual([{ status, safe_error_code: code, completed: true }]);
      const facts = await previewTerminalFacts(preview.previewRunId);
      expect(facts.audit).toHaveLength(1);
      expect(facts.usage).toHaveLength(1);
      await waitUntil(expiresAt);
      const restarted = coordinator();
      try {
        expect(await restarted.processNext()).toMatchObject({
          status: 'completed',
          previewRunId: preview.previewRunId,
        });
      } finally {
        await restarted.close();
      }
      expect(
        (
          await scopedQuery('select id from app.preview_runs where id=$1', [
            preview.previewRunId,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await scopedQuery(
            'select id from app.preview_attempts where preview_run_id=$1',
            [preview.previewRunId],
          )
        ).rows,
      ).toEqual([]);
    },
  );
});
