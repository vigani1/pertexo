import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  parseCompatibilityReleaseExpectation,
  parseCompatibilityReleaseExpectationHistory,
  parseCompatibilityReleaseExpectationSet,
} from '../src/compatibility/compatibility-release.js';
import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

const migrationUrl = new URL(
  '../migrations/0017_node_compatibility_releases.sql',
  import.meta.url,
);
const nonRemovalMigrationUrl = new URL(
  '../migrations/0018_phase3_core_executor_non_removal.sql',
  import.meta.url,
);
const preactivationMigrationUrl = new URL(
  '../migrations/0019_node_compatibility_preactivation.sql',
  import.meta.url,
);

describe('node compatibility release persistence', () => {
  it('owns one append-only initial release and a durable current pointer', async () => {
    const migration = await readFile(migrationUrl, 'utf8');
    const nonRemovalMigration = await readFile(nonRemovalMigrationUrl, 'utf8');
    const preactivationMigration = await readFile(
      preactivationMigrationUrl,
      'utf8',
    );

    expect(EXPECTED_MIGRATION_HEAD).toBe('0076_replay_lineage_retention.sql');
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
    expect(nonRemovalMigration).toContain(
      'app.enforce_phase3_core_executor_non_removal',
    );
    expect(nonRemovalMigration).toContain(
      'node_compatibility_releases_phase3_core_non_removal',
    );
    for (const key of ['core.manual', 'core.set', 'core.terminate'])
      expect(nonRemovalMigration).toContain(key);
    expect(nonRemovalMigration).toContain("IN ('active', 'retained')");
    expect(preactivationMigration).toContain(
      'CREATE TABLE app.node_compatibility_preactivation_checks',
    );
    expect(preactivationMigration).toContain(
      'app.approve_node_compatibility_activation',
    );
    expect(preactivationMigration).toContain(
      'app.activate_node_compatibility_release',
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

  it('separates retained execution history from a bounded rolling readiness overlap', () => {
    const release = {
      epoch: 1,
      fingerprint:
        'node-compat:v1:sha256:cf21b2e644563beb8b031481e9d5182b361b4ae2d4abd1d7d86d7b3fe0299f59',
      catalogJson:
        '{"domain":"pertexo.node-compatibility-release","schemaVersion":1}',
    } as const;
    expect(
      parseCompatibilityReleaseExpectationSet([
        release,
        { ...release, epoch: 2 },
      ]),
    ).toHaveLength(2);
    expect(() =>
      parseCompatibilityReleaseExpectationSet([release, release]),
    ).toThrow('must be unique');
    expect(() =>
      parseCompatibilityReleaseExpectationSet([
        release,
        { ...release, epoch: 2 },
        { ...release, epoch: 3 },
      ]),
    ).toThrow('readiness supports one rolling overlap');
    expect(
      parseCompatibilityReleaseExpectationHistory([
        release,
        { ...release, epoch: 2 },
        { ...release, epoch: 3 },
      ]),
    ).toHaveLength(3);
    expect(() =>
      parseCompatibilityReleaseExpectationHistory([release, release]),
    ).toThrow('must be unique');
    expect(() =>
      createWorkspaceDatabase(
        parseDatabaseConfig({
          connectionString: 'postgresql://localhost/pertexo',
        }),
        {
          compatibilityRelease: release,
          compatibilityReleases: [release],
        },
      ),
    ).toThrow('ambiguous');
  });
});
