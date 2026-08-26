import type { RetentionDatabase } from '@pertexo/database';
import type { DualRegionControlLedger } from '@pertexo/artifact-store';
import type { RetentionEnforcementCoordinator } from '@pertexo/database';
import type { PreviewRetentionCoordinator } from '@pertexo/database';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';
import { describe, expect, it, vi } from 'vitest';

import type { RetentionMetrics } from '../src/metrics.js';
import { runRetentionWorker } from '../src/run.js';

function resources(outcomes: ('completed' | 'idle' | 'stale')[]) {
  const controller = new AbortController();
  const events: string[] = [];
  const processNext = vi.fn(() => {
    const status = outcomes.shift() ?? 'idle';
    events.push(`process:${status}`);
    if (status !== 'completed') controller.abort(new Error('stop'));
    return Promise.resolve(
      status === 'idle'
        ? ({ status } as const)
        : ({
            batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            eligibleCount: 3,
            examinedCount: 3,
            pageCount: 2,
            status,
            workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          } as const),
    );
  });
  const database = {
    checkReadiness: vi.fn(() => {
      events.push('database-ready');
      return Promise.resolve();
    }),
    claimDryRuns: vi.fn(),
    close: vi.fn(() => {
      events.push('database-close');
      return Promise.resolve();
    }),
    executeDryRunPage: vi.fn(),
    processNext,
    startDryRun: vi.fn(),
    startEnforcement: vi.fn(),
  } satisfies RetentionDatabase;
  const enforcement = {
    close: vi.fn(() => {
      events.push('enforcement-close');
      return Promise.resolve();
    }),
    processNext: vi.fn(() => Promise.resolve({ status: 'idle' as const })),
  } satisfies RetentionEnforcementCoordinator;
  const preview = {
    close: vi.fn(() => {
      events.push('preview-close');
      return Promise.resolve();
    }),
    processNext: vi.fn(() => Promise.resolve({ status: 'idle' as const })),
  } satisfies PreviewRetentionCoordinator;
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
  const metrics = {
    record: vi.fn(),
    recordFailure: vi.fn(),
    recordPreview: vi.fn(),
  } satisfies RetentionMetrics;
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
  return {
    artifacts: {
      checkReadiness: vi.fn(() => {
        events.push('artifacts-ready');
        return Promise.resolve({});
      }),
      close: vi.fn(() => events.push('artifacts-close')),
    },
    controller,
    database,
    enforcement,
    events,
    expectedMaintenanceRole: 'pertexo_maintenance',
    logger,
    ledger,
    metrics,
    pollIntervalMs: 1,
    preview,
    processNext,
    signal: controller.signal,
    telemetry,
  };
}

describe('retention worker', () => {
  it('proves authority, drains completed work, records metrics, and closes', async () => {
    const input = resources(['completed', 'idle']);

    await expect(runRetentionWorker(input)).resolves.toBeUndefined();

    expect(input.events).toEqual([
      'telemetry-start',
      'database-ready',
      'ledger-ready',
      'artifacts-ready',
      'process:completed',
      'process:idle',
      'preview-close',
      'artifacts-close',
      'enforcement-close',
      'database-close',
      'ledger-close',
      'telemetry-close',
    ]);
    expect(input.metrics.record).toHaveBeenCalledTimes(4);
  });

  it('does not claim when readiness fails and still closes resources', async () => {
    const input = resources([]);
    input.database.checkReadiness = vi.fn(() =>
      Promise.reject(new Error('authority unavailable')),
    );

    await expect(runRetentionWorker(input)).rejects.toThrow(
      'Retention worker did not stop cleanly',
    );
    expect(input.processNext).not.toHaveBeenCalled();
    expect(input.events.slice(-2)).toEqual(['ledger-close', 'telemetry-close']);
  });
});
