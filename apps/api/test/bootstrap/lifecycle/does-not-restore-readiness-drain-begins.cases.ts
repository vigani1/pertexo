import type { WorkspaceDatabase } from '@pertexo/database/testing';

import { expect, it, vi } from 'vitest';

import { ApiDrainState } from '../../../src/platform/health/drain-state.js';
import { ReadyController } from '../../../src/platform/health/ready.controller.js';

import { database } from '../fixture.js';

export function registerDoesNotRestoreReadinessDrainBegins(): void {
  it('does not restore readiness when drain begins during a pending health check', async () => {
    type Readiness = Awaited<ReturnType<WorkspaceDatabase['checkReadiness']>>;
    let resolveReadiness!: (value: Readiness) => void;
    const pendingReadiness = new Promise<Readiness>((resolve) => {
      resolveReadiness = resolve;
    });
    const checkReadiness = vi.fn(() => pendingReadiness);
    const drain = new ApiDrainState();
    const controller = new ReadyController(
      { ...database, checkReadiness },
      drain,
    );

    const response = controller.ready();
    await vi.waitFor(() => {
      expect(checkReadiness).toHaveBeenCalledOnce();
    });
    drain.beginDrain();
    resolveReadiness({
      migrationHead: '0000_rls_probe.sql',
      postgresMajor: 18,
      role: 'pertexo_app',
    });

    await expect(response).rejects.toMatchObject({ status: 503 });
  });

  it('aborts application-owned streams when drain begins', () => {
    const drain = new ApiDrainState();
    const stream = new AbortController();
    const release = drain.registerStream(stream);

    drain.beginDrain();

    expect(stream.signal.aborted).toBe(true);
    expect(drain.activeStreamCount()).toBe(1);
    release();
    expect(drain.activeStreamCount()).toBe(0);
  });
}
