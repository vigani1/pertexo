import { describe, expect, it } from 'vitest';

import { JOB_NAME } from '../src/names.js';
import {
  canonicalizeQueueJob,
  canonicalizeQueueJobData,
  queueJobChecksum,
} from '../src/checksum.js';

const IDS = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  outboxEventId: '88888888-8888-4888-8888-888888888888',
} as const;

describe('queue job checksums', () => {
  it('canonicalizes object keys recursively while preserving array order', () => {
    const first = {
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        schemaVersion: 1,
        workspaceId: IDS.workspaceId,
        runId: IDS.runId,
        outboxEventId: IDS.outboxEventId,
      },
    } as const;
    const reordered = {
      data: {
        outboxEventId: IDS.outboxEventId,
        runId: IDS.runId,
        workspaceId: IDS.workspaceId,
        schemaVersion: 1,
      },
      name: JOB_NAME.advanceWorkflowRun,
    } as const;

    expect(canonicalizeQueueJob(first)).toBe(canonicalizeQueueJob(reordered));
    expect(canonicalizeQueueJobData(first)).toBe(
      `{"outboxEventId":"${IDS.outboxEventId}","runId":"${IDS.runId}","schemaVersion":1,"workspaceId":"${IDS.workspaceId}"}`,
    );
    expect(queueJobChecksum(first)).toBe(queueJobChecksum(reordered));
  });

  it('changes the checksum when a validated identifier is tampered with', () => {
    const original = {
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        schemaVersion: 1,
        workspaceId: IDS.workspaceId,
        runId: IDS.runId,
        outboxEventId: IDS.outboxEventId,
      },
    } as const;
    const tampered = {
      ...original,
      data: {
        ...original.data,
        runId: '99999999-9999-4999-8999-999999999999',
      },
    } as const;

    expect(queueJobChecksum(original)).not.toBe(queueJobChecksum(tampered));
  });

  it('does not checksum an envelope with payload-like or unknown fields', () => {
    expect(() =>
      canonicalizeQueueJob({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId: IDS.workspaceId,
          runId: IDS.runId,
          outboxEventId: IDS.outboxEventId,
          payload: { secret: 'not-allowed' },
        },
      } as never),
    ).toThrow();
  });
});
