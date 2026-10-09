import { describe, expect, it, vi } from 'vitest';

import type { RetentionMetrics } from '../../src/retention/metrics.js';
import { createRetentionRuntime } from '../../src/retention/runtime.js';

const idleReap = {
  authenticationLegacyAttemptsDeleted: 0,
  authenticationLinkAttemptsDeleted: 0,
  authenticationMailDeleted: 0,
  authenticationMailExpired: 0,
  authenticationProofsDeleted: 0,
  identitySecurityAuditDeleted: 0,
  idempotencyRecordsDeleted: 0,
  invitationAcceptanceIntentsDeleted: 0,
  invitationReplacementClaimsDeleted: 0,
  invitationsExpired: 0,
  sessionsDeleted: 0,
  workspaceCreationRecordsDeleted: 0,
};

function setup() {
  const resources = {
    database: {
      checkReadiness: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      enforce: vi.fn().mockResolvedValue({ removed: {}, more: false }),
      reapTransientData: vi.fn().mockResolvedValue(idleReap),
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
    recordTransientDataReap: vi.fn(),
    recordWorkspacePurge: vi.fn(),
  } satisfies RetentionMetrics;
  const logger = { error: vi.fn() };
  const runtime = createRetentionRuntime(
    resources,
    metrics,
    logger as never,
    60_000,
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
