import { describe, expect, it, vi } from 'vitest';

import type { RetentionMetrics } from '../../src/retention/metrics.js';
import { createRetentionRuntime } from '../../src/retention/runtime.js';

function setup(pollMillis = 60_000) {
  const resources = {
    database: {
      checkReadiness: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      enforce: vi.fn().mockResolvedValue({ removed: {}, more: false }),
    },
    preview: {
      close: vi.fn().mockResolvedValue(undefined),
      processNext: vi.fn().mockResolvedValue({ status: 'idle' }),
    },
    runArtifacts: {
      close: vi.fn().mockResolvedValue(undefined),
      processNext: vi.fn().mockResolvedValue({ status: 'idle' }),
    },
    workspacePurge: {
      close: vi.fn().mockResolvedValue(undefined),
      processNext: vi.fn().mockResolvedValue({ status: 'idle' }),
    },
    release: vi.fn().mockResolvedValue(undefined),
  };
  const metrics = {
    recordFailure: vi.fn(),
    recordPreview: vi.fn(),
    recordRetention: vi.fn(),
    recordRunArtifact: vi.fn(),
    recordWorkspacePurge: vi.fn(),
  } satisfies RetentionMetrics;
  const logger = { error: vi.fn() };
  const runtime = createRetentionRuntime(
    resources,
    metrics,
    logger as never,
    pollMillis,
  );
  return { logger, metrics, resources, runtime };
}

describe('retention runtime', () => {
  it('checks the database, then drains each operation until it is idle', async () => {
    const { metrics, resources, runtime } = setup();
    resources.workspacePurge.processNext
      .mockResolvedValueOnce({ status: 'started', workspaceId: 'workspace-1' })
      .mockResolvedValueOnce({
        status: 'progressed',
        workspaceId: 'workspace-1',
        step: 'workflow_runs',
      })
      .mockResolvedValueOnce({ status: 'idle' });

    runtime.start();
    await runtime.checkReadiness();

    expect(resources.database.checkReadiness).toHaveBeenCalledOnce();
    expect(resources.workspacePurge.processNext).toHaveBeenCalledTimes(3);
    expect(resources.database.enforce).toHaveBeenCalledOnce();
    expect(metrics.recordWorkspacePurge).toHaveBeenCalledTimes(3);
    await runtime.close();
  });

  it('logs a failing operation and still runs the others and stays ready', async () => {
    const { logger, metrics, resources, runtime } = setup();
    const failure = new Error('object store unavailable');
    resources.preview.processNext.mockRejectedValueOnce(failure);

    runtime.start();
    await runtime.checkReadiness();

    expect(metrics.recordFailure).toHaveBeenCalledWith(
      'preview',
      expect.any(Number),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'retention.operation_failed',
      { operation: 'preview' },
      failure,
    );
    expect(resources.runArtifacts.processNext).toHaveBeenCalledOnce();
    expect(resources.workspacePurge.processNext).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it('polls the other operations but runs the rules once while no page is full', async () => {
    const { resources, runtime } = setup(1);
    runtime.start();
    await vi.waitFor(() => {
      expect(
        resources.workspacePurge.processNext.mock.calls.length,
      ).toBeGreaterThan(3);
    });
    await runtime.close();

    expect(resources.database.enforce).toHaveBeenCalledOnce();
  });

  it('comes straight back to the rules after a full page, and after a failure', async () => {
    const { resources, runtime } = setup(1);
    resources.database.enforce
      .mockResolvedValueOnce({ removed: {}, more: true })
      .mockRejectedValueOnce(new Error('database unavailable'));
    runtime.start();
    await vi.waitFor(() => {
      expect(resources.database.enforce).toHaveBeenCalledTimes(3);
    });
    await runtime.close();
  });

  it('closes every coordinator and the shared resources on shutdown', async () => {
    const { resources, runtime } = setup();
    runtime.start();
    await runtime.checkReadiness();
    await runtime.close();

    for (const resource of [
      resources.database,
      resources.preview,
      resources.runArtifacts,
      resources.workspacePurge,
    ])
      expect(resource.close).toHaveBeenCalledOnce();
    expect(resources.release).toHaveBeenCalledOnce();
  });
});
