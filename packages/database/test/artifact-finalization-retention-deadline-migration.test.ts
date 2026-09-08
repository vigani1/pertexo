import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migration = await readFile(
  new URL(
    '../migrations/0083_artifact_finalization_retention_deadline.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('artifact finalization retention deadline migration', () => {
  it('grants only the deadline column to artifact writer roles', () => {
    expect(migration).toMatch(/GRANT UPDATE \(expires_at\) ON app\.artifacts/u);
    expect(migration).toContain('{{api_runtime_role}}');
    expect(migration).toContain('{{worker_runtime_role}}');
  });

  it('backfills the standard deadline for previously finalized user uploads', () => {
    expect(migration).toMatch(
      /UPDATE app\.artifacts[\s\S]+SET expires_at=finalized_at\+interval '30 days'[\s\S]+purpose='user-upload'[\s\S]+status='available'/u,
    );
  });
});
