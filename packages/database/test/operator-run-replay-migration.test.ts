import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('operator run replay migration', () => {
  it('keeps replay asynchronous, worker-mediated, and lineage explicit', async () => {
    const migration = await readFile(
      new URL('../migrations/0065_operator_run_replay.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain(
      'CREATE TABLE app.operator_run_replay_requests',
    );
    expect(migration).toContain("'replay-workflow-run'");
    expect(migration).toContain('ADD COLUMN replay_source_run_id uuid');
    expect(migration).toContain('ADD COLUMN replay_command_id uuid');
    expect(migration).toContain(
      'CREATE FUNCTION app.request_operator_run_replay(',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION app.complete_operator_run_replay(uuid,uuid,uuid)',
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]*\{\{operator_role\}\}/u,
    );
  });
});
