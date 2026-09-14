import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createWorkflowAuthoringDatabase } from '../src/authoring/workflow-authoring.js';
import { normalizeWorkflowAuthoringCompatibility } from '../src/authoring/workflow-authoring-compatibility.js';
import type {
  WorkflowAuthoringDatabaseOptions,
  WorkflowExecutableCompiler,
} from '../src/authoring/workflow-authoring-types.js';
import type { CompatibilityReleaseExpectation } from '../src/compatibility/compatibility-release.js';
import { createDatabaseRuntime } from '../src/platform/database-runtime.js';

const config = {
  connectionString: 'postgresql://invalid.invalid/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 1,
  ownerRole: 'pertexo_owner' as const,
  workerRuntimeRole: 'pertexo_worker' as const,
};
const catalogProjection = Object.freeze({
  domain: 'pertexo.node-compatibility-release',
  schemaVersion: 1,
});

function release(
  epoch: number,
  fingerprintCharacter: string,
): CompatibilityReleaseExpectation {
  return Object.freeze({
    epoch,
    fingerprint: `node-compat:v1:sha256:${fingerprintCharacter.repeat(64)}`,
    catalogJson:
      '{"domain":"pertexo.node-compatibility-release","schemaVersion":1}',
  });
}

const compiler: WorkflowExecutableCompiler = () => ({
  checksum: `wf:v2:sha256:${'0'.repeat(64)}`,
  executableSchemaVersion: 2,
  executableJson: {},
  compatibilityReleaseEpoch: 1,
  compatibilityReleaseFingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
});

function variant(compatibilityRelease: CompatibilityReleaseExpectation) {
  const catalog = Object.freeze({
    schemaVersion: 1 as const,
    releaseFingerprint: compatibilityRelease.fingerprint,
    definitions: Object.freeze([]),
  });
  return Object.freeze({
    compatibilityRelease,
    definitionCatalog: catalog,
    placementDefinitionCatalog: catalog,
    executableCompiler: compiler,
  });
}

describe('workflow authoring compatibility normalization', () => {
  const first = release(1, 'a');
  const second = release(2, 'b');
  const third = release(3, 'c');

  it('rejects ambiguous and incomplete option modes before database ownership', () => {
    const connect = vi
      .spyOn(Pool.prototype, 'connect')
      .mockRejectedValue(new Error('Unexpected PostgreSQL checkout'));
    const invalid: readonly WorkflowAuthoringDatabaseOptions[] = [
      {
        compatibilityRelease: first,
        compatibilityReleaseVariants: [variant(first)],
      },
      { compatibilityReadinessReleases: [first] },
      {
        compatibilityReleaseVariants: [
          variant(first),
          variant(second),
          variant(third),
        ],
      },
      {
        compatibilityReadinessReleases: [third],
        compatibilityReleaseVariants: [variant(first), variant(second)],
      },
      {
        compatibilityReleaseVariants: [
          {
            ...variant(first),
            definitionCatalog: {
              schemaVersion: 1,
              releaseFingerprint: second.fingerprint,
              definitions: [],
            },
          },
        ],
      },
    ];

    try {
      for (const options of invalid)
        expect(() => createWorkflowAuthoringDatabase(config, options)).toThrow(
          TypeError,
        );
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });

  it('locks singular authority and returns its matching catalogs', async () => {
    const selected = variant(first);
    const query = vi.fn().mockResolvedValue({ rows: [{}] });
    const compatibility = normalizeWorkflowAuthoringCompatibility({
      compatibilityRelease: first,
      definitionCatalog: selected.definitionCatalog,
      placementDefinitionCatalog: selected.placementDefinitionCatalog,
      executableCompiler: selected.executableCompiler,
    });

    await expect(compatibility.selectLocked({ query })).resolves.toEqual(
      selected,
    );
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      first.epoch,
      first.fingerprint,
      first.catalogJson,
    ]);
  });

  it('selects only the locked rolling variant from a bounded readiness set', async () => {
    const firstVariant = variant(first);
    const secondVariant = variant(second);
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          epoch: second.epoch,
          fingerprint: second.fingerprint,
          catalog_json: catalogProjection,
        },
      ],
    });
    const compatibility = normalizeWorkflowAuthoringCompatibility({
      compatibilityReleaseVariants: [firstVariant, secondVariant],
      compatibilityReadinessReleases: [first, second],
    });

    await expect(compatibility.selectLocked({ query })).resolves.toEqual(
      secondVariant,
    );
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      JSON.stringify([
        {
          epoch: first.epoch,
          fingerprint: first.fingerprint,
          catalog: catalogProjection,
        },
        {
          epoch: second.epoch,
          fingerprint: second.fingerprint,
          catalog: catalogProjection,
        },
      ]),
    ]);
  });

  it('assembles a valid rolling factory with an injected runtime without checkout', async () => {
    const connect = vi
      .spyOn(Pool.prototype, 'connect')
      .mockRejectedValue(new Error('Unexpected PostgreSQL checkout'));
    const runtime = createDatabaseRuntime(config, { monitorLockWaits: false });
    const database = createWorkflowAuthoringDatabase(config, {
      compatibilityReleaseVariants: [variant(first), variant(second)],
      compatibilityReadinessReleases: [first, second],
      runtime,
    });
    try {
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await Promise.all([database.close(), runtime.close()]);
      connect.mockRestore();
    }
  });
});
