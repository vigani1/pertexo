import { randomUUID } from 'node:crypto';

import { parseStoredExecutionValue } from '@pertexo/core/runs';
import type { createQueueProducer } from '@pertexo/queue';
import type { Queue } from 'bullmq';

import { expect } from 'vitest';

import { spawnPreviewCrashChild } from '../../../support/previews/crash-process.js';
import {
  acceptDelivery,
  databaseUrl,
  previewState,
  previewTerminalFacts,
  providerEffectCount,
  redisUrl,
  validTraceparent,
  workerUrl,
  workspaceId,
} from '../../../support/previews/consumer.js';

import type { previewCrashCases } from './scenarios.js';
import type { PreviewCrashFixture } from './scenarios.js';

export async function preparePreviewCrashFixtures(
  context: Readonly<{
    cases: ReturnType<typeof previewCrashCases>;
    fixtures: PreviewCrashFixture[];
    producer: ReturnType<typeof createQueueProducer>;
    queue: Queue;
  }>,
) {
  const { cases, fixtures, producer, queue } = context;
  for (const [index, selected] of cases.entries()) {
    const delivery = await acceptDelivery(validTraceparent, {
      mayContactProvider: true,
      mayCauseExternalSideEffect: true,
      sideEffectClass: 'unsafe',
    });
    const effectKey = `preview-process-${selected.mode}-${randomUUID()}`;
    const child = spawnPreviewCrashChild({
      leaseDurationSeconds: 1,
      mode: selected.mode,
      providerEffectKey: effectKey,
      redisUrl,
      workerId: `preview-process-${String(index)}-${randomUUID().slice(0, 8)}`,
      workerUrl: databaseUrl(workerUrl),
      workspaceId,
    });
    try {
      await expect(child.evidence).resolves.toMatchObject({
        injectionPoint: 'preview.consumer_ready',
      });
      const job = await producer.publish({
        data: delivery.job.data,
        name: delivery.job.name,
      });
      const evidence = await child.next(
        (message) => message.injectionPoint === selected.expectedBarrier,
      );
      expect(evidence.injectionPoint).toBe(selected.expectedBarrier);
      await expect(queue.getJob(job.jobId)).resolves.not.toBeUndefined();
      await expect(
        queue.getJob(job.jobId).then((published) => published?.getState()),
      ).resolves.toBe('active');

      const atBarrier = await previewState(delivery.accepted.previewRunId);
      expect(atBarrier).toMatchObject({
        attempt_fence: '1',
        attempt_status: selected.barrierAttemptStatus,
        inbox_completed_count: selected.barrierInboxCompletedCount,
        inbox_count: '1',
        run_status: selected.barrierRunStatus,
      });
      expect(
        await previewTerminalFacts(delivery.accepted.previewRunId),
      ).toEqual({
        audit_count: selected.terminalCommitted
          ? selected.expectedAuditCount
          : '0',
        usage_count: selected.terminalCommitted
          ? selected.expectedUsageCount
          : '0',
      });
      expect(atBarrier?.dispatch_marked_at === null).toBe(
        !selected.expectedDispatch,
      );
      expect(await providerEffectCount(effectKey)).toBe(
        selected.expectedProviderCount,
      );
      if (selected.terminalCommitted) {
        expect(parseStoredExecutionValue(atBarrier?.output_ref)).toMatchObject({
          value: { executed: true, providerEffectKey: effectKey },
        });
      } else {
        expect(atBarrier?.output_ref).toBeNull();
      }
      expect(await child.kill()).toBe('SIGKILL');
      fixtures.push({ delivery, effectKey, jobId: job.jobId, selected });
    } catch (scenarioFailure: unknown) {
      let childCleanupFailure: unknown;
      await child.kill().catch((error: unknown) => {
        childCleanupFailure = error;
      });
      if (childCleanupFailure === undefined) throw scenarioFailure;
      throw new AggregateError(
        [scenarioFailure, childCleanupFailure],
        `Preview crash child cleanup failed for ${selected.mode}`,
      );
    }
  }
}
