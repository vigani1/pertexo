import { describe, expect, it } from 'vitest';

import { JOB_NAME, type QueueJob } from '../src/index.js';
import {
  parseQueueJob,
  QUEUE_JOB_REGISTRY,
  safeParseQueueJob,
} from '../src/contracts.js';

const IDS = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  nodeRunId: '33333333-3333-4333-8333-333333333333',
  attemptId: '44444444-4444-4444-8444-444444444444',
  previewRunId: '99999999-9999-4999-8999-999999999999',
  previewAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workflowId: '55555555-5555-4555-8555-555555555555',
  publishedVersionId: '66666666-6666-4666-8666-666666666666',
  artifactId: '77777777-7777-4777-8777-777777777777',
  notificationIntentId: '12121212-1212-4212-8212-121212121212',
  evidenceCommandId: '13131313-1313-4313-8313-131313131313',
  outboxEventId: '88888888-8888-4888-8888-888888888888',
} as const;

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('versioned queue contracts', () => {
  it('requires exact own envelope fields and immutable registry entries', () => {
    const inherited = Object.create({
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        schemaVersion: 1,
        workspaceId: IDS.workspaceId,
        runId: IDS.runId,
        outboxEventId: IDS.outboxEventId,
      },
    }) as Record<string, unknown>;
    inherited.x = 1;
    inherited.y = 2;

    expect(() => parseQueueJob(inherited)).toThrow(TypeError);
    expect(Object.isFrozen(QUEUE_JOB_REGISTRY)).toBe(true);
    for (const entry of Object.values(QUEUE_JOB_REGISTRY))
      expect(Object.isFrozen(entry)).toBe(true);
  });

  it('parses every supported identifier-only job', () => {
    const jobs: readonly [string, unknown][] = [
      [
        JOB_NAME.deliverRunFailureNotification,
        {
          schemaVersion: 1,
          workspaceId: IDS.workspaceId,
          notificationIntentId: IDS.notificationIntentId,
          outboxEventId: IDS.outboxEventId,
        },
      ],
      [
        JOB_NAME.advanceWorkflowRun,
        {
          schemaVersion: 1,
          workspaceId: IDS.workspaceId,
          runId: IDS.runId,
          outboxEventId: IDS.outboxEventId,
          traceparent: TRACEPARENT,
        },
      ],
      [
        JOB_NAME.executePreviewAttempt,
        {
          schemaVersion: 1,
          workspaceId: IDS.workspaceId,
          previewRunId: IDS.previewRunId,
          previewAttemptId: IDS.previewAttemptId,
          outboxEventId: IDS.outboxEventId,
        },
      ],
      [
        JOB_NAME.executeNodeAttempt,
        {
          schemaVersion: 1,
          workspaceId: IDS.workspaceId,
          runId: IDS.runId,
          nodeRunId: IDS.nodeRunId,
          attemptId: IDS.attemptId,
          outboxEventId: IDS.outboxEventId,
        },
      ],
      [
        JOB_NAME.reconcilePreviewAttempt,
        {
          schemaVersion: 1,
          workspaceId: IDS.workspaceId,
          previewRunId: IDS.previewRunId,
          previewAttemptId: IDS.previewAttemptId,
          attemptFenceToken: 7,
          outboxEventId: IDS.outboxEventId,
        },
      ],
      [
        JOB_NAME.reconcileUnknownOutcome,
        {
          schemaVersion: 1,
          workspaceId: IDS.workspaceId,
          attemptId: IDS.attemptId,
          evidenceCommandId: IDS.evidenceCommandId,
          outboxEventId: IDS.outboxEventId,
        },
      ],
      [
        JOB_NAME.sweepExpiredPreviews,
        {
          schemaVersion: 1,
          workspaceId: IDS.workspaceId,
          previewRunId: IDS.previewRunId,
          outboxEventId: IDS.outboxEventId,
        },
      ],
      [
        JOB_NAME.reconcileWorkflowTriggers,
        {
          schemaVersion: 1,
          workspaceId: IDS.workspaceId,
          workflowId: IDS.workflowId,
          publishedVersionId: IDS.publishedVersionId,
          outboxEventId: IDS.outboxEventId,
        },
      ],
      [
        JOB_NAME.expireArtifacts,
        {
          schemaVersion: 1,
          workspaceId: IDS.workspaceId,
          artifactId: IDS.artifactId,
          outboxEventId: IDS.outboxEventId,
        },
      ],
    ];

    for (const [name, data] of jobs) {
      const parsed: QueueJob = parseQueueJob({ name, data });

      expect(parsed.name).toBe(name);
      expect(parsed.data).toMatchObject({
        schemaVersion: 1,
        workspaceId: IDS.workspaceId,
        outboxEventId: IDS.outboxEventId,
      });
    }
  });

  it('rejects unknown names and schema versions', () => {
    for (const name of ['unknown-job', '__proto__', 'toString']) {
      expect(() =>
        parseQueueJob({
          name,
          data: {
            schemaVersion: 1,
            workspaceId: IDS.workspaceId,
            runId: IDS.runId,
            outboxEventId: IDS.outboxEventId,
          },
        }),
      ).toThrow(/unknown queue job/i);
    }

    const result = safeParseQueueJob({
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        schemaVersion: 2,
        workspaceId: IDS.workspaceId,
        runId: IDS.runId,
        outboxEventId: IDS.outboxEventId,
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects extra and payload-like fields', () => {
    const result = safeParseQueueJob({
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        schemaVersion: 1,
        workspaceId: IDS.workspaceId,
        runId: IDS.runId,
        outboxEventId: IDS.outboxEventId,
        payload: { graph: { nodes: [] } },
      },
    });

    expect(result.success).toBe(false);

    expect(() =>
      parseQueueJob({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId: IDS.workspaceId,
          runId: IDS.runId,
          outboxEventId: IDS.outboxEventId,
        },
        queueName: 'workflow-coordinator',
      }),
    ).toThrow(/name and data/i);
  });

  it('rejects malformed UUIDs and unbounded trace context', () => {
    const malformedId = safeParseQueueJob({
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        schemaVersion: 1,
        workspaceId: 'not-a-uuid',
        runId: IDS.runId,
        outboxEventId: IDS.outboxEventId,
      },
    });
    const malformedTraceparent = safeParseQueueJob({
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        schemaVersion: 1,
        workspaceId: IDS.workspaceId,
        runId: IDS.runId,
        outboxEventId: IDS.outboxEventId,
        traceparent: `${TRACEPARENT}extra`,
      },
    });
    const zeroTraceparent = safeParseQueueJob({
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        schemaVersion: 1,
        workspaceId: IDS.workspaceId,
        runId: IDS.runId,
        outboxEventId: IDS.outboxEventId,
        traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      },
    });

    expect(malformedId.success).toBe(false);
    expect(malformedTraceparent.success).toBe(false);
    expect(zeroTraceparent.success).toBe(false);
  });

  it('rejects an invalid preview reconciliation fence', () => {
    const result = safeParseQueueJob({
      name: JOB_NAME.reconcilePreviewAttempt,
      data: {
        schemaVersion: 1,
        workspaceId: IDS.workspaceId,
        previewRunId: IDS.previewRunId,
        previewAttemptId: IDS.previewAttemptId,
        attemptFenceToken: -1,
        outboxEventId: IDS.outboxEventId,
      },
    });

    expect(result.success).toBe(false);
  });
});
