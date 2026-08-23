import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0030_coordinator_retry_decisions.sql',
  import.meta.url,
);

describe('coordinator retry decision migration', () => {
  it('requires one complete finite failed-attempt observation tuple', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('node_attempts_executor_failure_complete');
    expect(sql).toContain('node_attempts_executor_failure_kind_valid');
    expect(sql).toContain('node_attempts_executor_error_kind_valid');
    expect(sql).toContain('node_attempts_retry_decision_valid');
    expect(sql).toContain('node_attempts_executor_failure_only_failed');
    expect(sql).toContain(
      "('pending','retry','failed','canceled','timed_out','outcome_unknown')",
    );
  });

  it('grants only the retry observation columns to the worker role', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('executor_possibly_dispatched, retry_decision');
    expect(sql).toContain('TO {{worker_runtime_role}}');
    expect(sql).not.toContain('TO {{api_runtime_role}}');
  });
});
