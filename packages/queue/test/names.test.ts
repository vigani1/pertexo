import { describe, expect, it } from 'vitest';

import {
  JOB_NAME,
  QUEUE_FOR_JOB,
  QUEUE_NAME,
  type JobName,
  type QueueName,
} from '../src/names.js';

describe('queue names', () => {
  it('owns the literal queue names from the execution contract', () => {
    expect(QUEUE_NAME).toEqual({
      workflowCoordinator: 'workflow-coordinator',
      nodeAttempts: 'node-attempts',
      triggerLifecycle: 'trigger-lifecycle',
      maintenance: 'maintenance',
    });
  });

  it('owns the literal job names and queue routing', () => {
    expect(JOB_NAME).toEqual({
      advanceWorkflowRun: 'advance-workflow-run',
      executeNodeAttempt: 'execute-node-attempt',
      reconcileWorkflowTriggers: 'reconcile-workflow-triggers',
      expireArtifacts: 'expire-artifacts',
    });
    expect(QUEUE_FOR_JOB).toEqual({
      [JOB_NAME.advanceWorkflowRun]: QUEUE_NAME.workflowCoordinator,
      [JOB_NAME.executeNodeAttempt]: QUEUE_NAME.nodeAttempts,
      [JOB_NAME.reconcileWorkflowTriggers]: QUEUE_NAME.triggerLifecycle,
      [JOB_NAME.expireArtifacts]: QUEUE_NAME.maintenance,
    });
  });

  it('keeps the public unions assignable to the literal registry', () => {
    const queue: QueueName = QUEUE_NAME.maintenance;
    const job: JobName = JOB_NAME.expireArtifacts;

    expect(QUEUE_FOR_JOB[job]).toBe(queue);
  });
});
