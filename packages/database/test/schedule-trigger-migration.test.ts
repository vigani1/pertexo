import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';

describe('schedule trigger migration contract', () => {
  it('persists immutable recurrence, unique occurrences, bounded leases, and narrow worker functions', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0040_schedule_triggers.sql');
    const migration = await readFile(
      new URL('../migrations/0040_schedule_triggers.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain('trigger_schedules_config_immutable');
    expect(migration).toContain('trigger_schedule_occurrences_identity_unique');
    expect(migration).toContain('FOR UPDATE OF schedule SKIP LOCKED');
    expect(migration).toContain(
      "lease_expires_at<=lease_acquired_at+interval '5 minutes'",
    );
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('complete_trigger_schedule_claim');
    expect(migration).toContain('release_trigger_schedule_claim');
    expect(migration).toContain('TO {{worker_runtime_role}}');
  });
});
