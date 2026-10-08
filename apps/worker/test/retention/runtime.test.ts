import { describe, expect, it, vi } from 'vitest';

import type { RetentionMetrics } from '../../src/retention/metrics.js';
import {
  createRetentionRuntime,
  type RetentionRuntimeResources,
} from '../../src/retention/runtime.js';

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
      processNext: vi.fn().mockResolvedValue({ status: 'idle' }),
      processOperatorRerun: vi.fn().mockResolvedValue(null),
      reapTransientData: vi.fn().mockResolvedValue(idleReap),
      scheduleEnforcement: vi.fn().mockResolvedValue({
        capacityLimited: false,
        cutoffAt: new Date(0),
        scannedCount: 0,
        scheduledCount: 0,
      }),
    },
    enforcement: {
      close: vi.fn().mockResolvedValue(undefined),
      processNext: vi.fn().mockResolvedValue({ status: 'idle' }),
    },
    lifecycleCommands: {
      checkReadiness: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      processNext: vi.fn().mockResolvedValue({ status: 'idle' }),
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
    record: vi.fn(),
    recordFailure: vi.fn(),
    recordLifecycleCommand: vi.fn(),
    recordOperatorRerun: vi.fn(),
    recordPreview: vi.fn(),
    recordRunArtifact: vi.fn(),
    recordSchedule: vi.fn(),
    recordTransientDataReap: vi.fn(),
    recordWorkspacePurge: vi.fn(),
  } satisfies RetentionMetrics;
  const logger = { error: vi.fn() };
  const runtime = createRetentionRuntime(
    resources as unknown as RetentionRuntimeResources,
    metrics,
    logger as never,
    60_000,
  );
  return { logger, metrics, resources, runtime };
}

describe('retention runtime', () => {
  it('checks both databases, then drains each operation until it is idle', async () => {
    const { metrics, resources, runtime } = setup();
    resources.lifecycleCommands.processNext
      .mockResolvedValueOnce({
        commandType: 'deletion_requested',
        operationId: 'operation-1',
        status: 'completed',
      })
      .mockResolvedValueOnce({ status: 'idle' });
    resources.workspacePurge.processNext
      .mockResolvedValueOnce({
        jobId: 'job-1',
        status: 'started',
        workspaceId: 'workspace-1',
      })
      .mockResolvedValueOnce({
        jobId: 'job-1',
        status: 'progressed',
        workspaceId: 'workspace-1',
      })
      .mockResolvedValueOnce({ status: 'idle' });

    runtime.start();
    await runtime.checkReadiness();

    expect(resources.database.checkReadiness).toHaveBeenCalledOnce();
    expect(resources.lifecycleCommands.checkReadiness).toHaveBeenCalledOnce();
    expect(resources.lifecycleCommands.processNext).toHaveBeenCalledTimes(2);
    expect(resources.workspacePurge.processNext).toHaveBeenCalledTimes(3);
    expect(metrics.recordLifecycleCommand).toHaveBeenCalledTimes(2);
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
      resources.enforcement,
      resources.lifecycleCommands,
      resources.preview,
      resources.runArtifacts,
      resources.workspacePurge,
    ])
      expect(resource.close).toHaveBeenCalledOnce();
    expect(resources.release).toHaveBeenCalledOnce();
  });
});
