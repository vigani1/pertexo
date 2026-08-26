import type { DualRegionControlLedger } from '@pertexo/artifact-store';
import type { WorkspaceLifecycleCommandCoordinator } from '@pertexo/database';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';
import { describe, expect, it, vi } from 'vitest';

import { runLifecycleCommandWorker } from '../src/run.js';

function resources(outcomes: ('completed' | 'idle' | 'released')[]) {
  const controller = new AbortController();
  const events: string[] = [];
  const processNext = vi.fn(() => {
    const outcome = outcomes.shift() ?? 'idle';
    events.push(`process:${outcome}`);
    if (outcome === 'completed') {
      return Promise.resolve({
        commandType: 'deletion_requested' as const,
        operationId: 'b720a345-bc65-4f78-82f5-bf059fd20a0f',
        status: outcome,
      });
    }
    if (outcome === 'released') {
      controller.abort(new Error('stop'));
      return Promise.resolve({
        commandType: 'deletion_requested' as const,
        operationId: 'b720a345-bc65-4f78-82f5-bf059fd20a0f',
        status: outcome,
      });
    }
    controller.abort(new Error('stop'));
    return Promise.resolve({ status: outcome } as const);
  });
  const coordinator = {
    close: vi.fn(() => {
      events.push('database-close');
      return Promise.resolve();
    }),
    processNext,
  } satisfies WorkspaceLifecycleCommandCoordinator;
  const ledger = {
    append: vi.fn(),
    checkReadiness: vi.fn(() => {
      events.push('ledger-ready');
      return Promise.resolve({
        bucket: 'primary',
        minRetentionDays: 30,
        prefix: 'control-ledger/workspaces/' as const,
        primary: {
          bucket: 'primary',
          minRetentionDays: 30,
          prefix: 'control-ledger/workspaces/' as const,
          region: 'eu-central-1',
        },
        recovery: {
          bucket: 'recovery',
          minRetentionDays: 30,
          prefix: 'control-ledger/workspaces/' as const,
          region: 'eu-west-1',
        },
        region: 'eu-central-1',
      });
    }),
    close: vi.fn(() => events.push('ledger-close')),
    read: vi.fn(),
    reconcile: vi.fn(),
  } satisfies DualRegionControlLedger;
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  } satisfies StructuredLogger;
  const telemetry = {
    enabled: false,
    get started() {
      return true;
    },
    shutdown: vi.fn(() => {
      events.push('telemetry-close');
      return Promise.resolve();
    }),
    start: vi.fn(() => events.push('telemetry-start')),
  } satisfies TelemetryLifecycle;
  const metrics = {
    recordControlLedgerReconciliation: vi.fn(),
    recordLifecycleCommand: vi.fn(),
  };
  return {
    coordinator,
    controller,
    events,
    ledger,
    logger,
    metrics,
    pollIntervalMs: 1,
    processNext,
    signal: controller.signal,
    telemetry,
  };
}

describe('runLifecycleCommandWorker', () => {
  it('proves readiness, drains completed work, and closes resources', async () => {
    const input = resources(['completed', 'idle']);

    await expect(runLifecycleCommandWorker(input)).resolves.toBeUndefined();

    expect(input.events).toEqual([
      'telemetry-start',
      'ledger-ready',
      'process:completed',
      'process:idle',
      'database-close',
      'ledger-close',
      'telemetry-close',
    ]);
    expect(input.processNext).toHaveBeenCalledTimes(2);
  });

  it('stops after a released command when shutdown is requested', async () => {
    const input = resources(['released']);

    await expect(runLifecycleCommandWorker(input)).resolves.toBeUndefined();
    expect(input.processNext).toHaveBeenCalledOnce();
  });

  it('does not claim when ledger readiness fails and still cleans up', async () => {
    const input = resources([]);
    input.ledger.checkReadiness = vi.fn(() =>
      Promise.reject(new Error('ledger unavailable')),
    );

    await expect(runLifecycleCommandWorker(input)).rejects.toThrow(
      'Lifecycle command worker did not stop cleanly',
    );
    expect(input.processNext).not.toHaveBeenCalled();
    expect(input.events.slice(-3)).toEqual([
      'database-close',
      'ledger-close',
      'telemetry-close',
    ]);
  });
});
