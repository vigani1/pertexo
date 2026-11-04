import { expect, it } from 'vitest';
import {
  fixture,
  key,
  scanner,
  checkpointFactory,
  counts,
} from './triggers-coordination.fixture.js';

it('rests a failed discovery head with safe evidence so the next limited scan starts another key', async () => {
  const broken = await fixture({ mode: 'debounce', key, quietSeconds: 3600 });
  const ready = await fixture({ mode: 'debounce', key, quietSeconds: 3600 });
  await broken.submit('broken', 'private input must stay private');
  await ready.submit('ready', 'healthy');
  await broken.query(
    "update app.trigger_coordinated_events set due_at=clock_timestamp()-interval '2 minutes' where status='pending'",
  );
  await ready.query(
    "update app.trigger_coordinated_events set due_at=clock_timestamp()-interval '1 minute' where status='pending'",
  );
  const cause = new Error('private incompatible executable details');
  const scan = () =>
    scanner.scanDue({
      limit: 1,
      checkpointFactory: (version) => {
        if (version.id === broken.versionId) throw cause;
        return checkpointFactory(version);
      },
    });
  const failure: unknown = await scan().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toContain(cause);
  await expect(scan()).resolves.toMatchObject({ examined: 1, started: 1 });
  expect(await counts(ready)).toMatchObject({ runs: 1 });
  expect(await counts(broken)).toMatchObject({ runs: 0 });
  const state = await broken.query<{
    status: string;
    reason: string;
    seconds: number;
  }>(`select status,reason,
    extract(epoch from due_at-clock_timestamp())::float8 seconds from app.trigger_coordinated_events where status='pending'`);
  expect(state[0]).toMatchObject({
    status: 'pending',
    reason: 'release_failed',
  });
  expect(state[0]?.seconds).toBeGreaterThan(30);
  expect(state[0]?.seconds).toBeLessThanOrEqual(60);
  await broken.query(
    "update app.trigger_coordinated_events set due_at=clock_timestamp()-interval '1 second' where status='pending'",
  );
  await scanner.scanDue({ limit: 1, checkpointFactory });
  expect(await counts(broken)).toMatchObject({ runs: 1 });
  expect(
    await broken.query(
      'select status,reason from app.trigger_coordinated_events',
    ),
  ).toEqual([{ status: 'started', reason: null }]);
});
