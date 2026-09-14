import { CORE_REGISTRY_RELEASE_SUCCESSOR } from '@pertexo/nodes-core';
import { describe, expect, it, vi } from 'vitest';

import {
  activateCompatibilityReleaseFixture,
  type CompatibilityReleaseFixtureFactories,
} from './support/compatibility-release.fixture.js';

function options(factories: CompatibilityReleaseFixtureFactories) {
  return {
    actorId: '11111111-1111-4111-8111-111111111111',
    apiUrl: 'postgresql://api:secret@localhost:5432/pertexo',
    artifactPrefix: 'test-artifact',
    factories,
    migrationUrl: 'postgresql://owner:secret@localhost:5432/pertexo',
    readCurrent: vi.fn().mockResolvedValue({
      catalog_json: {},
      epoch: 1,
      fingerprint: `sha256:${'a'.repeat(64)}`,
    }),
    reasons: {
      activate: 'test activation',
      approve: 'test approval',
      prepare: 'test preparation',
    },
    targetRelease: CORE_REGISTRY_RELEASE_SUCCESSOR,
    workerUrl: 'postgresql://worker:secret@localhost:5432/pertexo',
  };
}

function maintenance(close: () => Promise<void> | void = vi.fn()) {
  return {
    activate: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn().mockResolvedValue(undefined),
    close,
    prepare: vi.fn().mockResolvedValue(undefined),
    recordPreactivation: vi.fn().mockResolvedValue(undefined),
  };
}

function probe(close: () => Promise<void> | void = vi.fn()) {
  return {
    checkTarget: vi.fn().mockResolvedValue(undefined),
    close,
  };
}

describe('compatibility release fixture ownership', () => {
  it('closes earlier owners when later probe acquisition fails', async () => {
    const owner = maintenance();
    const api = probe();
    const failure = new Error('worker probe construction failed');
    const readinessProbe = vi
      .fn()
      .mockReturnValueOnce(api)
      .mockImplementationOnce(() => {
        throw failure;
      });

    await expect(
      activateCompatibilityReleaseFixture(
        options({
          maintenance: vi.fn(() => owner),
          readinessProbe,
        } as unknown as CompatibilityReleaseFixtureFactories),
      ),
    ).rejects.toBe(failure);
    expect(owner.close).toHaveBeenCalledOnce();
    expect(api.close).toHaveBeenCalledOnce();
  });

  it('preserves the operation failure and every independent cleanup failure', async () => {
    const primary = new Error('prepare failed');
    const maintenanceClose = new Error('maintenance close failed');
    const apiClose = new Error('api close failed');
    const workerClose = new Error('worker close failed');
    const owner = maintenance(() => {
      throw maintenanceClose;
    });
    owner.prepare.mockRejectedValue(primary);
    const probes = [
      probe(() => Promise.reject(apiClose)),
      probe(() => {
        throw workerClose;
      }),
    ];
    const failure = await activateCompatibilityReleaseFixture(
      options({
        maintenance: vi.fn(() => owner),
        readinessProbe: vi
          .fn()
          .mockReturnValueOnce(probes[0])
          .mockReturnValueOnce(probes[1]),
      } as unknown as CompatibilityReleaseFixtureFactories),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      primary,
      maintenanceClose,
      apiClose,
      workerClose,
    ]);
  });
});
