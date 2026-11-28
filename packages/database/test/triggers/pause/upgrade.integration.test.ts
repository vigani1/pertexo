import { randomUUID } from 'node:crypto';
import { copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  migrateDatabase,
  MIGRATIONS_DIRECTORY,
} from '../../../src/migrations/migrate-database.js';
import {
  seedWorkflow,
  withDatabase,
} from '../../platform/migrations/upgrade-fixture.js';

it('refuses incomplete paused workflow state on the baseline', async () => {
  await withDatabase(async ({ admin }) => {
    const { workflowId } = await seedWorkflow(admin);
    for (const [reason, failures] of [
      [null, 3],
      ['consecutive_failures', null],
      [null, null],
    ])
      await expect(
        admin.query(
          "update app.workflows set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),trigger_pause_reason=$2,trigger_pause_failures=$3 where id=$1",
          [workflowId, reason, failures],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'workflows_trigger_pause_valid',
      });
  });
});

it('upgrades both automatic pause causes and enforces each pause-state branch', async () => {
  await withDatabase(
    async ({ admin, config, directory }) => {
      const release = '0015_manual_trigger_pause.sql';
      const copyMigration = (filename: string) =>
        copyFile(
          join(MIGRATIONS_DIRECTORY, filename),
          join(directory, filename),
        );
      const history = (await readdir(MIGRATIONS_DIRECTORY))
        .filter((name) => name.endsWith('.sql') && name < release)
        .sort();
      for (const filename of history) await copyMigration(filename);
      expect((await migrateDatabase(config, directory)).at(-1)).toMatch(
        /^0014_/u,
      );

      const run = await seedWorkflow(admin);
      const poll = await seedWorkflow(admin);
      const timestamp = '2026-11-28T08:00:00.123456Z';
      const pollError = 'http.poll_authentication';
      await admin.query(
        `update app.workflows set trigger_pause_state='paused', trigger_paused_at=$2,
           trigger_pause_reason='consecutive_failures', trigger_pause_failures=4,
           trigger_pause_last_run_id=$3, trigger_pause_poll_trigger_id=$4,
           trigger_pause_poll_error_code=$5, trigger_pause_revision=$6 where id=$1`,
        [run.workflowId, timestamp, randomUUID(), null, null, '19'],
      );
      await admin.query(
        `update app.workflows set trigger_pause_state='paused', trigger_paused_at=$2,
           trigger_pause_reason='consecutive_failures', trigger_pause_failures=6,
           trigger_pause_poll_trigger_id=$3, trigger_pause_poll_error_code=$4,
           trigger_pause_revision=$5 where id=$1`,
        [poll.workflowId, timestamp, randomUUID(), pollError, '23'],
      );

      const readWorkflows = async () =>
        (
          await admin.query<{ workflow: Record<string, unknown> }>(
            'select to_jsonb(workflows) as workflow from app.workflows order by id',
          )
        ).rows.map(({ workflow }) => workflow);
      const before = await readWorkflows();
      await copyMigration(release);
      await expect(migrateDatabase(config, directory)).resolves.toEqual([
        release,
      ]);
      expect(await readWorkflows()).toEqual(
        before.map((workflow) => ({ ...workflow, trigger_paused_by: null })),
      );

      const manual = await seedWorkflow(admin);
      await expect(
        admin.query(
          `update app.workflows set trigger_pause_state='paused', trigger_paused_at=$2,
           trigger_pause_reason='manual', trigger_paused_by=$3 where id=$1`,
          [manual.workflowId, timestamp, manual.ownerId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      const unpaused = await seedWorkflow(admin);
      for (const query of [
        {
          text: 'update app.workflows set trigger_paused_by=$2 where id=$1',
          values: [unpaused.workflowId, unpaused.ownerId],
        },
        {
          text: 'update app.workflows set trigger_paused_by=null where id=$1',
          values: [manual.workflowId],
        },
        {
          text: 'update app.workflows set trigger_pause_failures=3, trigger_pause_last_run_id=$2 where id=$1',
          values: [manual.workflowId, randomUUID()],
        },
        {
          text: 'update app.workflows set trigger_pause_last_run_id=null where id=$1',
          values: [run.workflowId],
        },
        {
          text: 'update app.workflows set trigger_pause_poll_error_code=null where id=$1',
          values: [poll.workflowId],
        },
        {
          text: 'update app.workflows set trigger_paused_by=$2 where id=$1',
          values: [run.workflowId, run.ownerId],
        },
        {
          text: 'update app.workflows set trigger_pause_revision=0 where id=$1',
          values: [unpaused.workflowId],
        },
      ]) {
        await expect(admin.query(query)).rejects.toMatchObject({
          code: '23514',
          constraint: 'workflows_trigger_pause_valid',
        });
      }
    },
    { migrate: false },
  );
});
