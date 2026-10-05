import { createRegistryRelease, type NodeManifest } from '@pertexo/node-sdk';
import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
import { platformExecutableRegistryHistory } from '@pertexo/node-catalog';
import {
  composeExecutableCompatibilityRelease,
  composeExecutableCompatibilityReleaseV3,
  describeExecutableCompatibilityRelease,
} from '@pertexo/workflow-engine';
import {
  createCoordinatorRunStore,
  createDatabaseRuntime,
} from '@pertexo/database/execution';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { composeWorkerWorkflowCompatibilityRelease } from '../src/platform/workflow-compatibility.js';

// Actual already-built Call definition, deliberately absent from serving
// catalogs. This local source qualification fixture does not register a release.
const { CORE_WORKFLOW_CALL_MANIFEST: manifest } = (await import(
  new URL(
    '../../../packages/nodes-core/dist/workflow-call/definition.js',
    import.meta.url,
  ).href
)) as { CORE_WORKFLOW_CALL_MANIFEST: NodeManifest };

function localNativeRelease(withExecutor = true) {
  return describeExecutableCompatibilityRelease(
    composeExecutableCompatibilityReleaseV3(
      createRegistryRelease({
        epoch: CORE_REGISTRY_RELEASE.epoch,
        definitions: [...CORE_REGISTRY_RELEASE.definitions, manifest],
        executors: [
          ...CORE_REGISTRY_RELEASE.executors,
          ...(withExecutor
            ? [
                {
                  executor: manifest.executor,
                  abiVersion: manifest.executorAbi ?? 1,
                  definitions: [manifest.definition],
                  lifecycle: 'active' as const,
                  policyReferences: manifest.policyReferences,
                },
              ]
            : []),
        ],
        policies: [
          ...CORE_REGISTRY_RELEASE.policies,
          { key: 'workflow.call', version: 1 },
        ],
      }),
    ),
  );
}
const config = {
  connectionString: 'postgresql://invalid.invalid/pertexo',
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 1_000,
  max: 1,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
};

describe('native coordinator capability admission, source only (no registered SQL)', () => {
  it('accepts the ordinary staged V3 read capability without making Call active', async () => {
    const staged = platformExecutableRegistryHistory('workflow_call_staging')
      .slice(-2)
      .map(composeWorkerWorkflowCompatibilityRelease)
      .map(describeExecutableCompatibilityRelease);
    const runtime = createDatabaseRuntime(
      { ...config, connectionTimeoutMillis: 100 },
      { monitorLockWaits: false },
    );
    let store: ReturnType<typeof createCoordinatorRunStore> | undefined;
    try {
      expect(() => {
        store = createCoordinatorRunStore(
          { ...config, connectionTimeoutMillis: 100 },
          runtime,
          {
            expectedCompatibilityReleases: staged,
            nativeValueControlReadTimeoutMillis: 250,
          },
        );
      }).not.toThrow();
      const catalog = JSON.parse(staged[1]?.catalogJson ?? '{}') as {
        executors: { executor: { key: string }; lifecycle: string }[];
      };
      expect(
        catalog.executors.find(
          (row) => row.executor.key === 'core.workflow_call',
        )?.lifecycle,
      ).toBe('staged');
    } finally {
      await store?.close();
      await runtime.close();
    }
  });
  it('keeps every retained baseline history fingerprint/catalog exact while composing actual Call locally', async () => {
    const retained = platformExecutableRegistryHistory('validate_activation')
      .map(composeExecutableCompatibilityRelease)
      .map(describeExecutableCompatibilityRelease);
    const before = JSON.stringify(retained);
    const native = localNativeRelease();
    expect(native.fingerprint).not.toBe(retained[0]?.fingerprint);
    expect(
      JSON.stringify(
        platformExecutableRegistryHistory('validate_activation')
          .map(composeExecutableCompatibilityRelease)
          .map(describeExecutableCompatibilityRelease),
      ),
    ).toBe(before);
    const runtime = createDatabaseRuntime(config, { monitorLockWaits: false });
    const store = createCoordinatorRunStore(config, runtime, {
      expectedCompatibilityReleases: retained.slice(-2),
    });
    try {
      expect(store.inspectCoordinatorValueReadOwner).toBeUndefined();
      await expect(store.checkReadiness?.()).resolves.toBeUndefined();
    } finally {
      await store.close();
      await runtime.close();
    }
  });

  it('rejects default 5000/2000 before acquiring any pool or reading native payloads', () => {
    const connect = vi
      .spyOn(Pool.prototype, 'connect')
      .mockImplementation(() => {
        throw new Error('Unexpected checkout');
      });
    try {
      expect(() =>
        createCoordinatorRunStore(config, undefined, {
          expectedCompatibilityReleases: [localNativeRelease()],
          nativeValueControlReadTimeoutMillis: 2_000,
        }),
      ).toThrow('Actual shared pool acquisition bound');
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });

  it('refuses an incomplete Call executor release and a mismatched catalog digest', () => {
    // The actual SDK/compiler itself refuses a definition with no owned executor.
    expect(() => localNativeRelease(false)).toThrow();
    const native = localNativeRelease();
    expect(() =>
      createCoordinatorRunStore(
        { ...config, connectionTimeoutMillis: 100 },
        undefined,
        {
          expectedCompatibilityReleases: [
            {
              ...native,
              fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
            },
          ],
        },
      ),
    ).toThrow('fingerprint differs');
  });

  it('keeps compatible configuration non-ready and unusable when the registered inline catalog cannot be read', async () => {
    const connect = vi
      .spyOn(Pool.prototype, 'connect')
      .mockImplementation(() => {
        throw new Error('Unavailable registered catalog');
      });
    const admittedConfig = { ...config, connectionTimeoutMillis: 100 };
    const runtime = createDatabaseRuntime(admittedConfig, {
      monitorLockWaits: false,
    });
    const store = createCoordinatorRunStore(admittedConfig, runtime, {
      expectedCompatibilityReleases: [localNativeRelease()],
      nativeValueControlReadTimeoutMillis: 250,
    });
    try {
      await expect(store.checkReadiness?.()).rejects.toThrow(
        'Unavailable registered catalog',
      );
      expect(() =>
        store.loadAdvanceState({
          workspaceId: '11111111-1111-4111-8111-111111111111',
          runId: '22222222-2222-4222-8222-222222222222',
          signal: new AbortController().signal,
        }),
      ).toThrow('has not passed owner readiness');
      expect(connect).toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      await store.close();
      await runtime.close();
    }
  });
});
