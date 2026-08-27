import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';

describe('operator outbox redispatch migration', () => {
  it('keeps the operator on narrow functions with durable replay and audit', () => {
    const migration = readFileSync(
      new URL(
        '../migrations/0061_operator_outbox_redispatch.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(EXPECTED_MIGRATION_HEAD).toBe('0066_operator_maintenance_rerun.sql');
    expect(migration).toContain('CREATE TABLE app.operator_commands');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain("ELSE 'conflict' END");
    expect(migration).toContain("'operator.outbox_redispatch'");
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.redispatch_failed_outbox_event\([\s\S]*TO \{\{operator_role\}\}/u,
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION app.get_operator_command(uuid,uuid,varchar,varchar)',
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION app\.redispatch_failed_outbox_event\([\s\S]*FROM PUBLIC,\{\{api_runtime_role\}\},\{\{worker_runtime_role\}\},\{\{dispatcher_role\}\}/u,
    );
    expect(migration).not.toMatch(
      /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*TO \{\{operator_role\}\}/u,
    );
  });
});
