import { expect, it, vi } from 'vitest';

import {
  createRunArtifactRetentionCoordinator,
  maintenanceUrl,
  parseDatabaseConfig,
  randomUUID,
  workspaceId,
} from '../retention.support.js';
import {
  readCapacity,
  insertExpiredPendingUserUpload,
  readArtifactRetentionState,
  setArtifactRetryAt,
} from './fixture.js';

export function registerKeepsExpiredPendingUploadDeleting(): void {
  it('keeps an expired pending upload deleting and charged across a store failure', async () => {
    const artifactId = randomUUID();
    const before = await readCapacity();
    await insertExpiredPendingUserUpload(artifactId, 'e');
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: before.chargedBytes + 10,
      chargedCount: before.chargedCount + 1,
    });
    const artifacts = {
      delete: vi
        .fn()
        .mockRejectedValueOnce(new Error('artifact store unavailable'))
        .mockResolvedValue(undefined),
      head: vi
        .fn()
        .mockResolvedValueOnce({ stillPresent: true })
        .mockResolvedValueOnce(null),
    };
    const createCoordinator = () =>
      createRunArtifactRetentionCoordinator(
        parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
        artifacts,
      );
    const coordinator = createCoordinator();
    try {
      await expect(coordinator.processNext()).rejects.toThrow(
        'artifact store unavailable',
      );
      expect(artifacts.head).not.toHaveBeenCalled();
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: before.chargedBytes + 10,
        chargedCount: before.chargedCount + 1,
      });
    } finally {
      await coordinator.close();
    }

    const restartedAfterFailure = createCoordinator();
    try {
      await expect(restartedAfterFailure.processNext()).resolves.toEqual({
        status: 'idle',
      });
      expect(await readArtifactRetentionState(artifactId)).toEqual({
        status: 'deleting',
        retryScheduled: true,
      });
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: before.chargedBytes + 10,
        chargedCount: before.chargedCount + 1,
      });

      await setArtifactRetryAt(artifactId, 'past');
      await expect(restartedAfterFailure.processNext()).resolves.toMatchObject({
        artifactId,
        status: 'waiting',
        workspaceId,
      });
      expect(await readArtifactRetentionState(artifactId)).toEqual({
        status: 'deleting',
        retryScheduled: true,
      });
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: before.chargedBytes + 10,
        chargedCount: before.chargedCount + 1,
      });
    } finally {
      await restartedAfterFailure.close();
    }

    const restartedAfterWaiting = createCoordinator();
    try {
      await expect(restartedAfterWaiting.processNext()).resolves.toEqual({
        status: 'idle',
      });
      expect(await readArtifactRetentionState(artifactId)).toEqual({
        status: 'deleting',
        retryScheduled: true,
      });

      await setArtifactRetryAt(artifactId, 'null');
      await expect(restartedAfterWaiting.processNext()).resolves.toMatchObject({
        artifactId,
        status: 'completed',
        workspaceId,
      });
    } finally {
      await restartedAfterWaiting.close();
    }
    expect(artifacts.delete).toHaveBeenCalledTimes(3);
    expect(artifacts.head).toHaveBeenCalledTimes(2);
    await expect(readCapacity()).resolves.toEqual(before);
  });
}
