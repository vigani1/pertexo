import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

const migrationUrl = new URL(
  '../migrations/0080_expired_artifact_upload_retention.sql',
  import.meta.url,
);

describe('expired artifact upload retention migration', () => {
  it('extends the existing retention owner to clean up pending uploads', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe(
      '0080_expired_artifact_upload_retention.sql',
    );
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain("artifact.status='pending'");
    expect(migration).toContain("artifact.purpose='user-upload'");
    expect(migration).toContain("OR artifact.status='deleting'");
    expect(migration).toContain('NOT EXISTS (SELECT 1 FROM app.artifact_links');
    expect(migration).toContain(
      "SET retention_retry_at=clock_timestamp()+interval '1 minute'",
    );
    expect(migration).not.toContain("SET status='available'");
  });
});
