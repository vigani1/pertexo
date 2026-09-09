import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migration = await readFile(
  new URL(
    '../migrations/0085_artifact_media_type_http_safety.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('artifact media-type HTTP safety migration', () => {
  it('replaces and validates the persisted media-type constraint', () => {
    expect(migration).toContain('DROP CONSTRAINT artifacts_media_type_format');
    expect(migration).toContain('ADD CONSTRAINT artifacts_media_type_format');
    expect(migration).toContain('NOT VALID');
    expect(migration).toContain(
      'VALIDATE CONSTRAINT artifacts_media_type_format',
    );
  });

  it('permits only Node-compatible field-value code points', () => {
    expect(migration).toContain(
      "media_type !~ U&'[^\\0009\\0020-\\007e\\0080-\\00ff]'",
    );
  });
});
