import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseCompatibilityReleaseExpectation } from '../src/compatibility-release.js';
import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';

const migrationUrl = new URL(
  '../migrations/0017_node_compatibility_releases.sql',
  import.meta.url,
);

describe('node compatibility release persistence', () => {
  it('owns one append-only initial release and a durable current pointer', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    expect(EXPECTED_MIGRATION_HEAD).toBe(
      '0017_node_compatibility_releases.sql',
    );
    expect(migration).toContain('CREATE TABLE app.node_compatibility_releases');
    expect(migration).toContain('CREATE TABLE app.node_compatibility_current');
    expect(migration).toContain(
      'node-compat:v1:sha256:cf21b2e644563beb8b031481e9d5182b361b4ae2d4abd1d7d86d7b3fe0299f59',
    );
    expect(migration).toContain('app.reject_node_compatibility_release_change');
    expect(migration).toContain('app.lock_node_compatibility_current');
    expect(migration).toMatch(
      /GRANT SELECT ON app\.node_compatibility_releases, app\.node_compatibility_current TO \{\{api_runtime_role\}\}, \{\{worker_runtime_role\}\}/u,
    );
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER[\s\S]+FROM \{\{api_runtime_role\}\}, \{\{worker_runtime_role\}\}, \{\{dispatcher_role\}\}/u,
    );
  });

  it('accepts only a bounded canonical V1 catalog expectation', () => {
    const expectation = {
      epoch: 1,
      fingerprint:
        'node-compat:v1:sha256:cf21b2e644563beb8b031481e9d5182b361b4ae2d4abd1d7d86d7b3fe0299f59',
      catalogJson:
        '{"domain":"pertexo.node-compatibility-release","schemaVersion":1}',
    } as const;

    expect(parseCompatibilityReleaseExpectation(expectation)).toEqual(
      expectation,
    );
    expect(() =>
      parseCompatibilityReleaseExpectation({
        ...expectation,
        catalogJson:
          '{ "domain": "pertexo.node-compatibility-release", "schemaVersion": 1 }',
      }),
    ).toThrow('not canonical');
    expect(() =>
      parseCompatibilityReleaseExpectation({
        ...expectation,
        fingerprint: 'node-compat:v1:sha256:not-a-digest',
      }),
    ).toThrow();
  });
});
