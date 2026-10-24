import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { acceptWorkflowRun } from '../../../src/runs/commands/acceptance.repository.js';
import { WorkflowAlreadyRunningError } from '../../../src/runs/commands/acceptance/errors.js';
import {
  apiDatabase,
  hasPostgresCode,
  installExecutionAcceptanceFixture,
  workspaceA,
  workflowId,
} from '../../runs/acceptance/fixtures.js';
import {
  acceptRun,
  claimRuns,
  publishClaims,
  transitionRun,
  withConcurrencyControls,
  withOwner,
} from './concurrency-admission.fixtures.js';

installExecutionAcceptanceFixture();
async function skip(limit: number | null = 1) {
  await withConcurrencyControls(async (store, scope) => {
    const current = await store.readSettings(scope);
    const saved = await store.updateSettings({
      ...scope,
      limit,
      overflow: 'skip',
      expectedRevision: current.revision,
      idempotencyKey: randomUUID(),
    });
    expect(saved.settings).toMatchObject({ limit, overflow: 'skip' });
  });
}
async function retainedCounts() {
  return withOwner(
    async (client) =>
      (
        await client.query<{
          runs: number;
          checkpoints: number;
          outbox: number;
          receipts: number;
        }>(
          `select (select count(*)::int from app.workflow_runs) runs,
            (select count(*)::int from app.run_checkpoints) checkpoints,
            (select count(*)::int from app.outbox_events) outbox,
            (select count(*)::int from app.idempotency_records where operation='workflow.run.accept') receipts`,
        )
      ).rows[0],
  );
}
describe('workflow Skip admission', () => {
  it('serializes simultaneous new events before dispatcher reservations exist', async () => {
    await skip();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => acceptRun()),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toBeInstanceOf(WorkflowAlreadyRunningError);
    expect(await retainedCounts()).toEqual({
      runs: 1,
      checkpoints: 1,
      outbox: 1,
      receipts: 1,
    });
  });
  it('answers exact accepted requests at the limit, including racing retries', async () => {
    await skip();
    const first = await acceptRun();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        apiDatabase.withWorkspace(workspaceA, (tx) =>
          acceptWorkflowRun(tx, first.request),
        ),
      ),
    );
    expect(
      results.every(
        (result) => result.runId === first.runId && result.duplicate,
      ),
    ).toBe(true);
    expect(await retainedCounts()).toEqual({
      runs: 1,
      checkpoints: 1,
      outbox: 1,
      receipts: 1,
    });
  });
  it('counts a reserved run once, preserves waits and permits a fresh event after completion', async () => {
    await skip(2);
    const first = await acceptRun();
    await publishClaims(await claimRuns());
    const second = await acceptRun();
    await expect(acceptRun()).rejects.toBeInstanceOf(
      WorkflowAlreadyRunningError,
    );
    await transitionRun(first.runId, 'waiting');
    await expect(acceptRun()).rejects.toBeInstanceOf(
      WorkflowAlreadyRunningError,
    );
    await transitionRun(first.runId, 'succeeded');
    expect((await acceptRun()).runId).not.toBe(second.runId);
  });
  it('shares the cap across publications and lets unrelated workflows accept', async () => {
    await skip();
    await acceptRun();
    await expect(
      acceptRun({ workflowVersionId: randomUUID() }),
    ).rejects.toBeInstanceOf(WorkflowAlreadyRunningError);
    await expect(
      acceptRun({ workflowId: randomUUID(), workflowVersionId: randomUUID() }),
    ).resolves.toHaveProperty('runId');
  });
  it('keeps Queue as the default and leaves existing backlog intact when selecting Skip', async () => {
    const first = await acceptRun();
    const second = await acceptRun();
    await skip();
    await expect(acceptRun()).rejects.toBeInstanceOf(
      WorkflowAlreadyRunningError,
    );
    expect(await retainedCounts()).toEqual({
      runs: 2,
      checkpoints: 2,
      outbox: 2,
      receipts: 2,
    });
    await publishClaims(await claimRuns());
    await transitionRun(first.runId, 'running');
    await transitionRun(first.runId, 'succeeded');
    expect((await claimRuns()).events[0]?.aggregateId).toBe(second.runId);
  });
  it('ignores Skip without a workflow cap', async () => {
    await skip(null);
    await expect(acceptRun()).resolves.toHaveProperty('runId');
    await expect(acceptRun()).resolves.toHaveProperty('runId');
  });
  it('queues draft tests and Calls even when Skip occupancy is full', async () => {
    await skip();
    const first = await acceptRun();
    for (const triggerType of ['test', 'workflow_call'] as const) {
      await expect(
        apiDatabase.withWorkspace(workspaceA, (tx) =>
          acceptWorkflowRun(tx, {
            ...first.request,
            triggerType,
            scope: `skip-exempt:${triggerType}`,
            keyHash: 'a'.repeat(64),
          }),
        ),
      ).resolves.toHaveProperty('runId');
    }
  });
  it('refuses old writers instead of silently bypassing Skip', async () => {
    await skip();
    const run = await acceptRun();
    await expect(
      apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
        await db.execute(sql`insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
        values(${randomUUID()},${workspaceA},${workflowId},${run.request.workflowVersionId},'api','queued')`);
      }),
    ).rejects.toSatisfy(hasPostgresCode('PTC01'));
  });
  it('reads only the latest 20 retained skips for this workflow', async () => {
    await withConcurrencyControls(async (store, scope) => {
      await withOwner(async (client) => {
        await client.query(
          `insert into app.usage_events
            (id,workspace_id,category,quantity,resource_type,resource_id,idempotency_key,metadata,occurred_at)
           select gen_random_uuid(),$1,'trigger.skipped',1,'workflow',
             case when ordinal=32 then gen_random_uuid() else $2::uuid end,
             gen_random_uuid()::text,'{"triggerType":"webhook","reason":"concurrency_limit"}',
             statement_timestamp()-case when ordinal=31 then interval '100 days' else ordinal*interval '1 second' end
           from generate_series(1,32) ordinal`,
          [workspaceA, workflowId],
        );
      });
      const history = (await store.readSettings(scope)).recentSkips;
      expect(history).toHaveLength(20);
      for (const entry of history ?? [])
        expect(entry).toMatchObject({
          triggerType: 'webhook',
          reason: 'concurrency_limit',
        });
      const times = history?.map((entry) => entry.at) ?? [];
      expect(times).toEqual([...times].sort().reverse());
      expect(new Date(times.at(-1) ?? '').getTime()).toBeGreaterThan(
        Date.now() - 60_000,
      );
    });
  });
  it('preserves Skip when an older client changes only the limit', async () => {
    await skip();
    await withConcurrencyControls(async (store, scope) => {
      const current = await store.readSettings(scope);
      expect(current.overflow).toBe('skip');
      expect(
        (
          await store.updateSettings({
            ...scope,
            limit: null,
            expectedRevision: current.revision,
            idempotencyKey: randomUUID(),
          })
        ).settings,
      ).toMatchObject({ overflow: 'skip', limit: null });
    });
  });
});
