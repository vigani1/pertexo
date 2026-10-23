import type { WorkspaceDatabase } from '@pertexo/database/testing';

import type { TelemetryLifecycle } from '@pertexo/observability';
import { expect, it, vi } from 'vitest';

import { WorkerDrainState } from '../../src/runtime/shutdown/drain-state.js';
import { WorkerReadiness } from '../../src/runtime/health/readiness.js';
import {
  createWorkerApplication,
  database,
  workerConfig,
  dependencies,
} from './fixture.js';

export function registerSharesOneApplicationCloseSettlementCloses(): void {
  it('shares one application close settlement and closes each owner once', async () => {
    const databaseClose = vi.fn().mockResolvedValue(undefined);
    const selected = dependencies({ ...database, close: databaseClose });
    const app = await createWorkerApplication(workerConfig, selected);

    const first = app.close();
    const second = app.close();
    expect(second).toBe(first);
    await first;

    expect(selected.dispatcherClose).toHaveBeenCalledOnce();
    expect(selected.queueClose).toHaveBeenCalledOnce();
    expect(databaseClose).toHaveBeenCalledOnce();
    // Vitest inspects this mock identity; it never calls the unbound method.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(selected.telemetry.shutdown).toHaveBeenCalledOnce();
  });

  it('connects drain state to readiness and admission', async () => {
    const app = await createWorkerApplication(workerConfig, dependencies());
    const drainState = app.get(WorkerDrainState);
    const readiness = app.get(WorkerReadiness);

    expect(drainState.canAcceptWork()).toBe(true);
    drainState.beginDrain();
    expect(() => {
      readiness.assertCanAcceptWork();
    }).toThrow('worker is draining');
    await expect(readiness.checkReadiness()).rejects.toThrow(
      'worker is draining',
    );

    await app.close();
  });

  it('enters drain state before shutdown resources close', async () => {
    const lifecycle: { drainState?: WorkerDrainState } = {};
    const close = vi.fn().mockImplementation(() => {
      expect(lifecycle.drainState?.canAcceptWork()).toBe(false);
      return Promise.resolve();
    });
    const selectedDatabase: WorkspaceDatabase = { ...database, close };
    const app = await createWorkerApplication(
      workerConfig,
      dependencies(selectedDatabase),
    );
    lifecycle.drainState = app.get(WorkerDrainState);

    expect(app.get(WorkerDrainState).canAcceptWork()).toBe(true);
    await app.close();

    expect(close).toHaveBeenCalledOnce();
  });

  it('shuts telemetry down with the worker application lifecycle', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const telemetry = {
      enabled: true,
      started: true,
      start: vi.fn<NonNullable<TelemetryLifecycle['start']>>(),
      shutdown,
    } satisfies TelemetryLifecycle;
    const app = await createWorkerApplication(
      workerConfig,
      dependencies(database, telemetry),
    );

    await app.close();

    expect(shutdown).toHaveBeenCalledOnce();
  });
}
