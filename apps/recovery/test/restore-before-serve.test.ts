import type {
  DualRegionArtifactStore,
  DualRegionArtifactStoreReadiness,
  DualRegionControlLedger,
  DualRegionControlLedgerReadiness,
} from '@pertexo/artifact-store';
import type {
  ControlLedgerCoordinator,
  ControlLedgerInventoryResult,
} from '@pertexo/database';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';
import { describe, expect, it, vi } from 'vitest';

import { restoreBeforeServe } from '../src/restore-before-serve.js';

const readiness: DualRegionControlLedgerReadiness = {
  bucket: 'primary',
  minRetentionDays: 30,
  prefix: 'control-ledger/workspaces/',
  primary: {
    bucket: 'primary',
    minRetentionDays: 30,
    prefix: 'control-ledger/workspaces/',
    region: 'eu-central-1',
  },
  recovery: {
    bucket: 'recovery',
    minRetentionDays: 30,
    prefix: 'control-ledger/workspaces/',
    region: 'eu-west-1',
  },
  region: 'eu-central-1',
};
const inventory: ControlLedgerInventoryResult = {
  inventoryDigest: 'a'.repeat(64),
  projectedRecordCount: 2,
  sweepCount: 3,
  workspaceCount: 4,
};
const artifactReadiness: DualRegionArtifactStoreReadiness = {
  bucket: 'artifacts-primary',
  primary: { bucket: 'artifacts-primary', region: 'eu-central-1' },
  recovery: { bucket: 'artifacts-recovery', region: 'eu-west-1' },
  region: 'eu-central-1',
};
const artifact = {
  artifactId: '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c02',
  byteLength: 5,
  mediaType: 'text/plain',
  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  workspaceId: '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c01',
};

function resources(events: string[]) {
  const checkRestoreReadiness = vi.fn(() => {
    events.push('database-ready');
    return Promise.resolve();
  });
  const closeCoordinator = vi.fn(() => {
    events.push('database-close');
    return Promise.resolve();
  });
  const reconcileAllWorkspaces = vi.fn(() => {
    events.push('reconcile');
    return Promise.resolve(inventory);
  });
  const listCommittedArtifacts = vi.fn(() => {
    events.push('artifact-list');
    return Promise.resolve({ artifacts: [artifact], hasMore: false });
  });
  const coordinator = {
    checkRestoreReadiness,
    close: closeCoordinator,
    listCommittedArtifacts,
    placeLegalHold: vi.fn(),
    reconcileAllWorkspaces,
    reconcileWorkspace: vi.fn(),
    releaseLegalHold: vi.fn(),
  } as ControlLedgerCoordinator;
  const checkArtifactReadiness = vi.fn(() => {
    events.push('artifact-ready');
    return Promise.resolve(artifactReadiness);
  });
  const closeArtifacts = vi.fn(() => {
    events.push('artifact-close');
  });
  const verifyReplicas = vi.fn(() => {
    events.push('artifact-verify');
    return Promise.resolve(artifact);
  });
  const artifacts = {
    beginDirectUpload: vi.fn(),
    checkReadiness: checkArtifactReadiness,
    close: closeArtifacts,
    delete: vi.fn(),
    getStream: vi.fn(),
    head: vi.fn(),
    purgeWorkspacePage: vi.fn(),
    put: vi.fn(),
    validateDirectUpload: vi.fn(),
    verifyReplicas,
  } as DualRegionArtifactStore;
  const checkLedgerReadiness = vi.fn(() => {
    events.push('ledger-ready');
    return Promise.resolve(readiness);
  });
  const closeLedger = vi.fn(() => {
    events.push('ledger-close');
  });
  const ledger = {
    append: vi.fn(),
    checkReadiness: checkLedgerReadiness,
    close: closeLedger,
    read: vi.fn(),
    reconcile: vi.fn(),
  } as DualRegionControlLedger;
  const logInfo = vi.fn();
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: logInfo,
    trace: vi.fn(),
    warn: vi.fn(),
  } satisfies StructuredLogger;
  const shutdownTelemetry = vi.fn(() => {
    events.push('telemetry-close');
    return Promise.resolve();
  });
  const startTelemetry = vi.fn(() => {
    events.push('telemetry-start');
  });
  const telemetry = {
    enabled: false,
    get started() {
      return true;
    },
    shutdown: shutdownTelemetry,
    start: startTelemetry,
  } satisfies TelemetryLifecycle;
  const recordControlLedgerReconciliation = vi.fn();
  const metrics = {
    recordControlLedgerReconciliation,
    recordLifecycleCommand: vi.fn(),
  };
  return {
    artifactPageSize: 100,
    artifacts,
    coordinator,
    expectedMaintenanceRole: 'pertexo_maintenance',
    ledger,
    logger,
    metrics,
    maxArtifactPages: 10,
    signal: new AbortController().signal,
    spies: {
      checkLedgerReadiness,
      checkArtifactReadiness,
      checkRestoreReadiness,
      closeCoordinator,
      closeLedger,
      closeArtifacts,
      listCommittedArtifacts,
      logInfo,
      reconcileAllWorkspaces,
      recordControlLedgerReconciliation,
      shutdownTelemetry,
      startTelemetry,
      verifyReplicas,
    },
    telemetry,
  };
}

describe('restoreBeforeServe', () => {
  it('proves dependencies in order and closes every resource', async () => {
    const events: string[] = [];
    const input = resources(events);

    const result = await restoreBeforeServe(input);
    expect(result.inventory).toEqual(inventory);
    expect(result.ledger).toEqual(readiness);
    expect(result.artifacts).toMatchObject({
      artifactCount: 1,
      pageCount: 1,
      readiness: artifactReadiness,
    });
    expect(events).toEqual([
      'telemetry-start',
      'database-ready',
      'ledger-ready',
      'artifact-ready',
      'reconcile',
      'artifact-list',
      'artifact-verify',
      'database-close',
      'ledger-close',
      'artifact-close',
      'telemetry-close',
    ]);
    expect(input.spies.logInfo).toHaveBeenCalledWith(
      'restore_before_serve.completed',
      expect.objectContaining({ workspaceCount: 4 }),
    );
  });

  it('does not reconcile after ledger readiness fails and still cleans up', async () => {
    const events: string[] = [];
    const input = resources(events);
    input.spies.checkLedgerReadiness.mockRejectedValueOnce(
      new Error('ledger unavailable'),
    );

    await expect(restoreBeforeServe(input)).rejects.toThrow(
      'Restore-before-serve recovery did not complete cleanly',
    );
    expect(input.spies.reconcileAllWorkspaces).not.toHaveBeenCalled();
    expect(events.slice(-4)).toEqual([
      'database-close',
      'ledger-close',
      'artifact-close',
      'telemetry-close',
    ]);
  });

  it('fails the gate when successful work cannot be cleaned up', async () => {
    const events: string[] = [];
    const input = resources(events);
    input.spies.closeCoordinator.mockRejectedValueOnce(
      new Error('pool close failed'),
    );

    await expect(restoreBeforeServe(input)).rejects.toThrow(
      'Restore-before-serve recovery did not complete cleanly',
    );
    expect(input.spies.closeLedger).toHaveBeenCalledOnce();
    expect(input.spies.closeArtifacts).toHaveBeenCalledOnce();
    expect(input.spies.shutdownTelemetry).toHaveBeenCalledOnce();
  });

  it('fails closed when a committed artifact replica cannot be verified', async () => {
    const events: string[] = [];
    const input = resources(events);
    input.spies.verifyReplicas.mockRejectedValueOnce(
      new Error('recovery object missing'),
    );

    await expect(restoreBeforeServe(input)).rejects.toThrow(
      'Restore-before-serve recovery did not complete cleanly',
    );
    expect(input.spies.logInfo).not.toHaveBeenCalled();
    expect(input.spies.recordControlLedgerReconciliation).toHaveBeenCalledWith(
      'failed',
      expect.any(Number),
    );
  });

  it('fails closed when the artifact inventory exceeds its page bound', async () => {
    const events: string[] = [];
    const input = resources(events);
    input.maxArtifactPages = 1;
    input.spies.listCommittedArtifacts.mockResolvedValueOnce({
      artifacts: [artifact],
      hasMore: true,
    });

    await expect(restoreBeforeServe(input)).rejects.toThrow(
      'Restore-before-serve recovery did not complete cleanly',
    );
    expect(input.spies.verifyReplicas).toHaveBeenCalledOnce();
  });

  it('honors cancellation before any readiness probe', async () => {
    const events: string[] = [];
    const input = resources(events);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      restoreBeforeServe({ ...input, signal: controller.signal }),
    ).rejects.toThrow('Restore-before-serve recovery did not complete cleanly');
    expect(input.spies.checkRestoreReadiness).not.toHaveBeenCalled();
    expect(input.spies.checkLedgerReadiness).not.toHaveBeenCalled();
    expect(input.spies.checkArtifactReadiness).not.toHaveBeenCalled();
  });

  it('cleans up resources when telemetry cannot start', async () => {
    const events: string[] = [];
    const input = resources(events);
    input.spies.startTelemetry.mockImplementationOnce(() => {
      throw new Error('telemetry start failed');
    });

    await expect(restoreBeforeServe(input)).rejects.toThrow(
      'Restore-before-serve recovery did not complete cleanly',
    );
    expect(events).toEqual([
      'database-close',
      'ledger-close',
      'artifact-close',
      'telemetry-close',
    ]);
  });
});
