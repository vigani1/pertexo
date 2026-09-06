import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('schedule claim concurrency migration', () => {
  it('rechecks eligibility on the locked schedule without changing fairness or authority', async () => {
    const migration = await readFile(
      new URL(
        '../migrations/0081_schedule_claim_concurrency.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const lockingSelection = migration
      .split('), due AS (')[1]
      ?.split('), claimed AS (')[0];
    expect(lockingSelection).toBeDefined();
    for (const predicate of [
      'ranked.workspace_rank=1',
      "schedule.status='enabled'",
      'schedule.next_fire_at<=v_observed_at',
      'schedule.admission_deferred_until<=v_observed_at',
      'schedule.lease_expires_at<=v_observed_at',
      "trigger.status='active'",
      'LIMIT p_limit FOR UPDATE OF schedule SKIP LOCKED',
    ])
      expect(lockingSelection).toContain(predicate);
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain(
      'SET search_path=pg_catalog,app,pg_temp SET row_security=on',
    );
    expect(migration).toContain('OWNER TO {{owner_role}}');
    expect(migration).toContain('FROM PUBLIC');
    expect(migration).toContain('TO {{worker_runtime_role}}');
  });
});
