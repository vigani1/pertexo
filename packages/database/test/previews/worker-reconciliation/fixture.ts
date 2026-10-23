import { scopedQuery } from '../worker.fixture.js';

export async function waitForDatabaseTime(deadline: Date): Promise<void> {
  const stopAt = Date.now() + 5_000;
  while (Date.now() < stopAt) {
    const reached = await scopedQuery<{ reached: boolean }>(
      `select clock_timestamp() >= $1::timestamptz as reached`,
      [deadline],
    );
    if (reached.rows[0]?.reached === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('database clock did not reach preview execution deadline');
}
