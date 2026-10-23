import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  runs,
  person,
  busyWorkspace,
  quietWorkspace,
  intake,
  inWorkspace,
} from './fixture.js';

export function registerCountsLogicalTriggerSkipsSeparately(): void {
  it('counts logical trigger skips separately from runs in the same bounded workspace window', async () => {
    const id = randomUUID();
    await inWorkspace('api', busyWorkspace, {
      text: `insert into app.usage_events(id,workspace_id,category,quantity,resource_type,resource_id,idempotency_key,metadata) values($1,$2,'trigger.skipped',1,'workflow',$3,$4,'{"triggerType":"webhook","reason":"concurrency_limit"}')`,
      values: [id, busyWorkspace, intake, `trigger-skip:${id}`],
    });
    const result = await runs.statistics({
      actorId: person,
      workspaceId: busyWorkspace,
      window: '24h',
    });
    expect(result.window.skippedTriggerEvents).toBe(1);
    expect(result.window.total).toBe(
      Object.values(result.window.byStatus).reduce(
        (sum, count) => sum + count,
        0,
      ),
    );
    expect(
      (
        await runs.statistics({
          actorId: person,
          workspaceId: quietWorkspace,
          window: '24h',
        })
      ).window.skippedTriggerEvents,
    ).toBe(0);
  });
}
