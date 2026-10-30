import { describe, expect, it } from 'vitest';

import {
  JOB_NAME,
  QUEUE_FOR_JOB,
  QUEUE_NAME,
  type JobName,
  type QueueName,
} from '../../src/jobs/names.js';

describe('queue names', () => {
  it('keeps the public unions assignable to the literal registry', () => {
    const queue: QueueName = QUEUE_NAME.maintenance;
    const job: JobName = JOB_NAME.replayWorkflowRun;

    expect(QUEUE_FOR_JOB[job]).toBe(queue);
  });
});
