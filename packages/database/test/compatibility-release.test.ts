import { readFile } from 'node:fs/promises';

import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  checkCompatibilityReleasePreactivationTarget,
  CompatibilityReleaseMismatchError,
  lockExpectedCompatibilityReleaseWithClient,
  parseCompatibilityReleaseExpectation,
  parseCompatibilityReleaseExpectationHistory,
  parseCompatibilityReleaseExpectationSet,
} from '../src/compatibility/compatibility-release.js';
import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';

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

  it('accepts only a bounded compact V1 authority expectation', () => {
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
    ).toThrow('not a compact V1 authority expectation');
    expect(() =>
      parseCompatibilityReleaseExpectation({
        ...expectation,
        fingerprint: 'node-compat:v1:sha256:not-a-digest',
      }),
    ).toThrow();

    const catalog = {
      domain: 'pertexo.node-compatibility-release',
      schemaVersion: 1,
      padding: '',
    };
    const withoutPadding = JSON.stringify(catalog);
    catalog.padding = 'x'.repeat(
      128 * 1024 - Buffer.byteLength(withoutPadding),
    );
    const exactBoundary = JSON.stringify(catalog);
    expect(Buffer.byteLength(exactBoundary)).toBe(128 * 1024);
    expect(
      parseCompatibilityReleaseExpectation({
        ...expectation,
        catalogJson: exactBoundary,
      }),
    ).toMatchObject({ catalogJson: exactBoundary });
    expect(() =>
      parseCompatibilityReleaseExpectation({
        ...expectation,
        catalogJson: `${exactBoundary.slice(0, -2)}x"}`,
      }),
    ).toThrow('catalog is too large');
  });

  it('distinguishes a durable mismatch from an authority query failure', async () => {
    const expectation = {
      epoch: 1,
      fingerprint:
        'node-compat:v1:sha256:cf21b2e644563beb8b031481e9d5182b361b4ae2d4abd1d7d86d7b3fe0299f59',
      catalogJson:
        '{"domain":"pertexo.node-compatibility-release","schemaVersion":1}',
    } as const;
    const noMatch = {
      query: () => Promise.resolve({ rows: [] }),
    };
    const outage = new Error('socket reset');
    const unavailable = {
      query: async () => Promise.reject(outage),
    };

    await expect(
      lockExpectedCompatibilityReleaseWithClient(
        noMatch as unknown as Pick<Pool, 'query'>,
        expectation,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CompatibilityReleaseMismatchError);
      expect(error).toMatchObject({
        diagnosticCategory: 'mismatch',
        message: 'Node compatibility release does not match this artifact',
      });
      expect('cause' in (error as object)).toBe(false);
      return true;
    });
    await expect(
      lockExpectedCompatibilityReleaseWithClient(unavailable, expectation),
    ).rejects.toMatchObject({
      cause: outage,
      diagnosticCategory: 'query_failure',
      message: 'Node compatibility release does not match this artifact',
    });

    const hostile = Object.create(null) as object;
    await expect(
      checkCompatibilityReleasePreactivationTarget(
        // Deliberately exercises an adapter that violates Error conventions.
        {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          query: () => Promise.reject(hostile),
        } as unknown as Pool,
        [expectation],
        expectation,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CompatibilityReleaseMismatchError);
      expect(error).toMatchObject({
        cause: hostile,
        diagnosticCategory: 'query_failure',
      });
      return true;
    });
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
