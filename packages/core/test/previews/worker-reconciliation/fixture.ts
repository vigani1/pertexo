import { expect } from 'vitest';
import { scopedQuery } from '../worker.fixture.js';

export async function waitForDatabaseTime(deadline: Date): Promise<void> {
  await expect
    .poll(
      async () => {
        const reached = await scopedQuery<{ reached: boolean }>(
          'select clock_timestamp() >= $1::timestamptz as reached',
          [deadline],
        );
        return reached.rows[0]?.reached ?? false;
      },
      { timeout: 5_000, interval: 20 },
    )
    .toBe(true);
}
