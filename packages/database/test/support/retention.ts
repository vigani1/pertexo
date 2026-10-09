import { parseDatabaseConfig } from '../../src/config.js';
import { createRetentionDatabase } from '../../src/lifecycle/retention.js';
import type { RetentionRuleName } from '../../src/lifecycle/retention-rules.js';

/**
 * Runs retention passes through the maintenance role until nothing more is
 * due and returns the rows each rule removed in total.
 */
export async function enforceRetention(
  maintenanceUrl: string,
  pageSize = 1_000,
): Promise<Readonly<Record<RetentionRuleName, number>>> {
  const retention = createRetentionDatabase(
    parseDatabaseConfig({ connectionString: maintenanceUrl, max: 1 }),
    { pageSize },
  );
  const totals = new Map<RetentionRuleName, number>();
  try {
    for (let more = true; more;) {
      const pass = await retention.enforce();
      for (const [rule, count] of Object.entries(pass.removed) as [
        RetentionRuleName,
        number,
      ][])
        totals.set(rule, (totals.get(rule) ?? 0) + count);
      more = pass.more;
    }
  } finally {
    await retention.close();
  }
  return Object.freeze(
    Object.fromEntries(totals) as Record<RetentionRuleName, number>,
  );
}
