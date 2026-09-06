import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

describe('regional replica identity migration', () => {
  it('persists bounded identity cardinality and replaces the unsafe lookup', async () => {
    const sql = await readFile(
      new URL(
        '../migrations/0072_regional_replica_identity.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(EXPECTED_MIGRATION_HEAD).toBe('0079_artifact_upload_capacity.sql');
    expect(sql).toContain('replica_identity_status');
    expect(sql).toContain('replica_session_count');
    expect(sql).toContain("'missing'");
    expect(sql).toContain("'duplicate'");
    expect(sql).toContain('p_session_count');
    expect(sql).not.toContain(
      'CREATE FUNCTION app.record_regional_replica_lag(\n  p_application_name varchar,\n  p_replication_state varchar,\n  p_replay_lag_millis bigint\n)',
    );
    expect(sql).toContain(
      'record_regional_replica_lag(varchar,varchar,bigint,integer)',
    );
  });
});
