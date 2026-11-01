import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { createScheduleTriggerTestEnvironment } from '../support/schedule-triggers.js';

const schedule = createScheduleTriggerTestEnvironment();
const { actorId, ownerQuery, triggerId, workflowId, workspaceId } = schedule;

beforeAll(schedule.initialize);
afterAll(schedule.close);

// ADR 013/027: the workflow's Triggers page reads while the workspace is
// suspended, and nothing it offers changes a schedule.
it('lists schedules while suspended but refuses to change one', async () => {
  await ownerQuery(`update app.workspaces set status='suspended' where id=$1`, [
    workspaceId,
  ]);

  const items = await schedule.schedules.list({
    actorId,
    workflowId,
    workspaceId,
  });
  expect(items.map(({ id }) => id)).toContain(triggerId);

  const key = `suspended-${randomUUID()}`;
  await expect(
    schedule.schedules.setEnabled({
      actorId,
      enabled: false,
      idempotencyKey: key,
      requestHash: 'a'.repeat(64),
      triggerId,
      workflowId,
      workspaceId,
    }),
  ).rejects.toMatchObject({ code: 'not_found' });
});
