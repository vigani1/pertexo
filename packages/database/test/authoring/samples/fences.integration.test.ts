import { describe, expect, it } from 'vitest';
import { createWorkflowAuthoringFixtureDatabase } from '../../support/workflow-authoring-admission.fixture.js';
import { parseDatabaseConfig } from '../../../src/config.js';
import {
  authoring,
  actorId,
  workspaceId,
  randomUUID,
  queryAsOwner,
  ownerPool,
  apiPool,
  apiUrl,
  withApplicationName,
  waitForPostgresLock,
} from '../../support/workflow-authoring.js';
import { fixture, paste, testIntent } from './support.js';
import { PreviewAdmissionDeniedError } from '../../../src/previews/errors.js';
import { WorkflowNotFoundError } from '../../../src/authoring/workflows/errors.js';

describe('pinned sample admission fences', () => {
  it('rechecks authority for reads, writes and accepted-test receipts', async () => {
    const f = await fixture();
    const command = paste(f);
    const pin = await authoring.stepSamples.put(command);
    const intent = testIntent(f, pin.sampleId);
    await authoring.acceptPreview(intent);
    await queryAsOwner(
      "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
      [workspaceId, actorId],
      workspaceId,
    );
    try {
      await expect(authoring.stepSamples.get(f.scope)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
      await expect(authoring.stepSamples.put(command)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
      await expect(authoring.acceptPreview(intent)).rejects.toStrictEqual(
        new PreviewAdmissionDeniedError('actor'),
      );
    } finally {
      await queryAsOwner(
        "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
        workspaceId,
      );
    }
    expect((await authoring.stepSamples.put(command)).replayed).toBe(true);
    expect(
      (await apiPool.query('select id from app.workflow_step_samples')).rows,
    ).toEqual([]);
  });

  it.each(['replace', 'remove'] as const)(
    'refuses a pin %s that wins while preview admission waits',
    async (action) => {
      const f = await fixture();
      const pin = await authoring.stepSamples.put(paste(f));
      const appName = `sample-race-${randomUUID()}`;
      const contender = createWorkflowAuthoringFixtureDatabase(
        parseDatabaseConfig({
          connectionString: withApplicationName(apiUrl, appName),
          max: 1,
        }),
      );
      const blocker = await ownerPool.connect();
      let attempt: Promise<unknown> | undefined;
      try {
        await blocker.query('begin');
        await blocker.query('set local role pertexo_owner');
        await blocker.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await blocker.query(
          'select id from app.workflow_step_samples where id=$1 for update',
          [pin.sampleId],
        );
        attempt = contender.acceptPreview(testIntent(f, pin.sampleId));
        void attempt.catch(() => undefined);
        await waitForPostgresLock(appName);
        if (action === 'remove')
          await blocker.query(
            'delete from app.workflow_step_samples where id=$1',
            [pin.sampleId],
          );
        else
          await blocker.query(
            'update app.workflow_step_samples set id=$2 where id=$1',
            [pin.sampleId, randomUUID()],
          );
        await blocker.query('commit');
        await expect(attempt).rejects.toMatchObject({ reason: 'changed' });
      } finally {
        await blocker.query('rollback');
        blocker.release();
        await Promise.allSettled(attempt === undefined ? [] : [attempt]);
        await contender.close();
      }
      expect(
        await queryAsOwner(
          'select id from app.preview_runs where workflow_id=$1',
          [f.scope.workflowId],
        ),
      ).toEqual([]);
    },
  );

  it('checks expiry after a blocked sample read using the database clock', async () => {
    const f = await fixture();
    const pin = await authoring.stepSamples.put(paste(f));
    const appName = `sample-expiry-${randomUUID()}`;
    const contender = createWorkflowAuthoringFixtureDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(apiUrl, appName),
        max: 1,
      }),
    );
    const blocker = await ownerPool.connect();
    let attempt: Promise<unknown> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query('set local role pertexo_owner');
      await blocker.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await blocker.query(
        "update app.workflow_step_samples set created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()+interval '500 milliseconds' where id=$1",
        [pin.sampleId],
      );
      attempt = contender.acceptPreview(testIntent(f, pin.sampleId));
      void attempt.catch(() => undefined);
      await waitForPostgresLock(appName);
      // The lock crosses the stored expiry; no wall-clock mock can prove this fence.
      await blocker.query(
        'select pg_sleep(greatest(0,extract(epoch from (expires_at-clock_timestamp())))+0.01) from app.workflow_step_samples where id=$1',
        [pin.sampleId],
      );
      await blocker.query('commit');
      await expect(attempt).rejects.toMatchObject({ reason: 'expired' });
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await Promise.allSettled(attempt === undefined ? [] : [attempt]);
      await contender.close();
    }
  });
  it('charges concurrent workspace writes atomically and releases replacement bytes', async () => {
    const filled = await fixture(62);
    const value = 'x'.repeat(262142);
    for (let index = 0; index < 62; index += 1)
      await authoring.stepSamples.put({
        ...paste(filled, value),
        nodeId: index === 0 ? 'sample' : `sample-${String(index)}`,
      });
    const first = await fixture();
    const second = await fixture();
    const results = await Promise.allSettled([
      authoring.stepSamples.put(paste(first, value)),
      authoring.stepSamples.put(paste(second, value)),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { reason: 'limit_reached' } });
    const existing = await authoring.stepSamples.get(filled.scope);
    if (existing.sample === null)
      throw new Error('Quota fixture sample missing');
    await authoring.stepSamples.put({
      ...paste(filled, null),
      expectedSampleId: existing.sample.id,
    });
    const loser = results[0].status === 'rejected' ? first : second;
    await expect(
      authoring.stepSamples.put(paste(loser, value)),
    ).resolves.toMatchObject({ removed: false });
    const total = await queryAsOwner(
      'select sum(retained_bytes)::int bytes from app.workflow_step_samples where workspace_id=$1',
      [workspaceId],
    );
    expect(total[0]?.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});
