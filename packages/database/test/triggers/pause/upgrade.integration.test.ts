import { expect, it } from 'vitest';
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
