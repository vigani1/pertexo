import { describe, expect, it } from 'vitest';

import { admitQueueDelivery } from '../src/jobs/delivery-admission.js';
import {
  isJobIdOfOutboxEvent,
  jobIdForOutboxEvent,
} from '../src/jobs/job-id.js';

const EVENT = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';

const job = (id: string) => ({
  id,
  name: 'advance-workflow-run',
  data: { outboxEventId: EVENT, runId: RUN, workspaceId: WORKSPACE },
});

describe('the job ID of a delivery', () => {
  it('stays the same for a first delivery, and is new for each redelivery', () => {
    expect(jobIdForOutboxEvent(EVENT)).toBe(`outbox-${EVENT}`);
    expect(jobIdForOutboxEvent(EVENT, 0)).toBe(`outbox-${EVENT}`);
    expect(jobIdForOutboxEvent(EVENT, 3)).toBe(`outbox-${EVENT}-r3`);
  });

  it('never holds a colon, which BullMQ refuses', () => {
    expect(jobIdForOutboxEvent(EVENT, 3)).not.toContain(':');
  });

  it.each([
    [`outbox-${EVENT}`, true],
    [`outbox-${EVENT}-r1`, true],
    [`outbox-${EVENT}-r12`, true],
    [`outbox-${EVENT}-r0`, false],
    [`outbox-${EVENT}-r`, false],
    [`outbox-${EVENT}-rx`, false],
    [`outbox-${EVENT}-r1-r2`, false],
    [`outbox-${OTHER}-r1`, false],
    [EVENT, false],
  ])('%s belongs to the event: %s', (jobId, expected) => {
    expect(isJobIdOfOutboxEvent(jobId, EVENT)).toBe(expected);
  });

  it('admits a redelivery and refuses the job ID of another event', () => {
    expect(
      admitQueueDelivery('workflow-coordinator', job(`outbox-${EVENT}-r2`))
        .transportJobId,
    ).toBe(`outbox-${EVENT}-r2`);
    expect(() =>
      admitQueueDelivery('workflow-coordinator', job(`outbox-${OTHER}-r2`)),
    ).toThrow('does not match');
  });
});
