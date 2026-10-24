import { Pool, type QueryResult } from 'pg';
import { expect, it, vi } from 'vitest';

import { WorkflowPublishedVersionConflictError } from '../../../src/runs/errors.js';

import { enforceRetention } from '../../support/retention.js';
import {
  migrationUrl,
  maintenanceUrl,
  workspaceId,
  workflowId,
  workflowVersionId,
  retainedWorkflowVersionId,
  owner,
  database,
  checkpoint,
  startInput,
  ownerQuery,
  apiQuery,
} from './fixture.js';

export function registerRecoversAcceptedCheckedDuplicateRequests(): void {
  it('recovers accepted checked duplicate requests before publication change', async () => {
    const input = {
      ...startInput(),
      expectedPublishedVersionId: workflowVersionId,
    };
    const accepted = await database.start(input);
    await ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [workflowId, retainedWorkflowVersionId],
    );
    const duplicates = await Promise.all(
      Array.from({ length: 4 }, () => database.start(input)),
    );
    expect(duplicates).toEqual(
      Array.from({ length: 4 }, () => ({ ...accepted, replayed: true })),
    );
    expect(
      (
        await ownerQuery(
          'select count(*)::int count from app.workflow_manual_start_rejections',
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });

  it('serializes concurrent new checked starts to one acceptance', async () => {
    const input = {
      ...startInput(),
      expectedPublishedVersionId: workflowVersionId,
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => database.start(input)),
    );
    expect(new Set(results.map((result) => result.run.id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
  });

  it('releases a rejected key only after bounded expiry cleanup', async () => {
    const input = {
      ...startInput(),
      expectedPublishedVersionId: retainedWorkflowVersionId,
    };
    await expect(database.start(input)).rejects.toBeInstanceOf(
      WorkflowPublishedVersionConflictError,
    );
    await ownerQuery(
      "update app.workflow_manual_start_rejections set expires_at=clock_timestamp()-interval '1 second'",
    );
    expect(
      (await enforceRetention(maintenanceUrl)).manual_start_rejections,
    ).toBe(1);
    await ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [workflowId, retainedWorkflowVersionId],
    );
    await expect(
      database.start({
        ...input,
        checkpointFactory: () => ({
          checkpoint: checkpoint(retainedWorkflowVersionId),
        }),
      }),
    ).resolves.toMatchObject({
      replayed: false,
      run: { workflowVersionId: retainedWorkflowVersionId },
    });
  });

  it('holds publication through acceptance and recovers a concurrently blocked exact duplicate', async () => {
    await ownerQuery(`create function app.test_manual_start_pause() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(1934781132); return new; end $$;
      create trigger zzz_test_manual_start_pause before insert on app.workflow_runs
        for each row execute function app.test_manual_start_pause()`);
    const gate = await owner.connect();
    const publicationPool = new Pool({
      connectionString: migrationUrl,
      max: 1,
    });
    const publisher = await publicationPool.connect();
    let first: ReturnType<typeof database.start> | undefined;
    let duplicate: ReturnType<typeof database.start> | undefined;
    let publication: Promise<QueryResult> | undefined;
    try {
      await gate.query('select pg_advisory_lock(1934781132)');
      const input = {
        ...startInput(),
        expectedPublishedVersionId: workflowVersionId,
      };
      first = database.start(input);
      await vi.waitFor(
        async () => {
          const waiting = await apiQuery(
            "select count(*)::int count from pg_stat_activity where usename='pertexo_app' and wait_event='advisory'",
          );
          expect(waiting.rows[0]?.count).toBeGreaterThanOrEqual(1);
        },
        { timeout: 3000 },
      );
      duplicate = database.start(input);
      await publisher.query('begin');
      await publisher.query('set local role pertexo_owner');
      await publisher.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      publication = publisher.query(
        'update app.workflows set published_version_id=$2 where id=$1',
        [workflowId, retainedWorkflowVersionId],
      );
      await vi.waitFor(
        async () => {
          const waiting = await apiQuery(
            "select count(*)::int count from pg_stat_activity where usename='pertexo_app' and wait_event='advisory'",
          );
          expect(waiting.rows[0]?.count).toBeGreaterThanOrEqual(2);
        },
        { timeout: 3000 },
      );
      await gate.query('select pg_advisory_unlock(1934781132)');
      const accepted = await first;
      await publication;
      await publisher.query('commit');
      expect(await duplicate).toEqual({ ...accepted, replayed: true });
      expect(accepted.run.workflowVersionId).toBe(workflowVersionId);
      expect(
        (await apiQuery('select count(*)::int count from app.workflow_runs'))
          .rows,
      ).toEqual([{ count: 1 }]);
    } finally {
      await gate.query('select pg_advisory_unlock(1934781132)');
      if (publication !== undefined) await publication.catch(() => undefined);
      await publisher.query('rollback').catch(() => undefined);
      await Promise.allSettled([
        ...(first === undefined ? [] : [first]),
        ...(duplicate === undefined ? [] : [duplicate]),
      ]);
      publisher.release();
      gate.release();
      await publicationPool.end();
      await ownerQuery(
        'drop trigger zzz_test_manual_start_pause on app.workflow_runs; drop function app.test_manual_start_pause()',
      );
    }
  });

  it('rejects a checked command when publication commits before its authoritative lock', async () => {
    const publishing = await owner.connect();
    let attempted: ReturnType<typeof database.start> | undefined;
    try {
      await publishing.query('begin');
      await publishing.query('set local role pertexo_owner');
      await publishing.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await publishing.query(
        'update app.workflows set published_version_id=$2 where id=$1',
        [workflowId, retainedWorkflowVersionId],
      );
      attempted = database.start({
        ...startInput(),
        expectedPublishedVersionId: workflowVersionId,
      });
      // Attach the rejection observer before releasing publication.
      const rejected = expect(attempted).rejects.toBeInstanceOf(
        WorkflowPublishedVersionConflictError,
      );
      await publishing.query('commit');
      await rejected;
    } finally {
      await publishing.query('rollback').catch(() => undefined);
      if (attempted !== undefined) await attempted.catch(() => undefined);
      publishing.release();
    }
    expect(
      (await apiQuery('select count(*)::int count from app.workflow_runs'))
        .rows,
    ).toEqual([{ count: 0 }]);
  });
}
