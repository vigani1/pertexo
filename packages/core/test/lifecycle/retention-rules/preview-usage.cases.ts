import { generatePersistedId } from '@pertexo/database/platform';
import { expect, it } from 'vitest';

import { randomUUID, retention, workspaceId } from '../retention.support.js';
import { admin, daysAgo, enforceUntilIdle } from './fixture.js';

/** The run summary window a person is told about. */
const WINDOW_DAYS = 90;

async function usage(category: string, ageDays: number): Promise<string> {
  const id = generatePersistedId();
  await admin.query(
    `insert into app.usage_events(id,workspace_id,category,quantity,resource_type,resource_id,idempotency_key,metadata,occurred_at)
     values($1,$2,$3,1,'preview_run',$4,$5,'{}'::jsonb,$6)`,
    [id, workspaceId, category, randomUUID(), randomUUID(), daysAgo(ageDays)],
  );
  return id;
}

const remaining = async (ids: readonly string[]) => {
  const { rows } = await admin.query<{ id: string }>(
    'select id from app.usage_events where id=any($1::uuid[])',
    [ids],
  );
  return rows.map(({ id }) => id).sort();
};

export function registerPreviewUsage(): void {
  it('lets a step test usage row go at the run summary window, and nothing else with it', async () => {
    const expired = await usage('preview_execution', WINDOW_DAYS + 1);
    const recent = await usage('preview_execution', WINDOW_DAYS - 1);
    const otherOldCategory = await usage('preview.execution', WINDOW_DAYS + 30);

    await enforceUntilIdle();

    expect(await remaining([expired, recent, otherOldCategory])).toEqual(
      [recent, otherOldCategory].sort(),
    );
  });

  it('works through more than a page, and reports what it removed', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1)
      ids.push(await usage('preview_execution', WINDOW_DAYS + 1));

    let removed = 0;
    let passes = 0;
    for (; passes < 50; passes += 1) {
      const pass = await retention.enforce();
      removed += pass.removed.preview_usage;
      if (!pass.more) break;
    }

    expect(removed).toBe(ids.length);
    // The fixture's page is 2, so this took several passes.
    expect(passes).toBeGreaterThan(1);
    expect(await remaining(ids)).toEqual([]);
  });

  it('leaves a skipped trigger to its own rule', async () => {
    const skip = await usage('trigger.skipped', WINDOW_DAYS + 1);
    const first = await retention.enforce();
    expect(first.removed.preview_usage).toBe(0);
    await enforceUntilIdle();
    expect(await remaining([skip])).toEqual([]);
  });
}
