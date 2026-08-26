import type {
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
  const coordinator = {
    checkRestoreReadiness,
    close: closeCoordinator,
    placeLegalHold: vi.fn(),
    reconcileAllWorkspaces,
    reconcileWorkspace: vi.fn(),
    releaseLegalHold: vi.fn(),
  } as ControlLedgerCoordinator;
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
  return {
    coordinator,
    expectedMaintenanceRole: 'pertexo_maintenance',
    ledger,
    logger,
    signal: new AbortController().signal,
    spies: {
      checkLedgerReadiness,
      checkRestoreReadiness,
      closeCoordinator,
      closeLedger,
      logInfo,
      reconcileAllWorkspaces,
      shutdownTelemetry,
      startTelemetry,
    },
    telemetry,
  };
}

describe('restoreBeforeServe', () => {
  it('proves dependencies in order and closes every resource', async () => {
    const events: string[] = [];
    const input = resources(events);

    await expect(restoreBeforeServe(input)).resolves.toEqual({
      inventory,
      ledger: readiness,
    });
    expect(events).toEqual([
      'telemetry-start',
      'database-ready',
      'ledger-ready',
      'reconcile',
      'database-close',
      'ledger-close',
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
    expect(events.slice(-3)).toEqual([
      'database-close',
      'ledger-close',
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
    expect(input.spies.shutdownTelemetry).toHaveBeenCalledOnce();
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
      'telemetry-close',
    ]);
  });
});
