import { describe, expect, it } from 'vitest';
import {
  attemptReconciliationOutcome,
  automaticReconciliationAction,
  overdueDeliveryAction,
  evidenceOutcome,
  resumeOutcome,
  cancellationOutcome,
  redispatchOutcome,
  triggerReconciliationOutcome,
  runReplayOutcome,
} from '../src/operator/decisions.js';

describe('operator decisions', () => {
  const attempt = {
    status: 'running',
    fenceToken: 3,
    leaseExpired: true,
    dispatchMarkedAt: null as Date | null,
    sideEffectClass: 'safe',
  };
  const reclaim = {
    expectedFenceToken: 3,
    action: 'reclaim' as const,
    dryRun: false,
  };
  it('keeps fencing, lease expiry and unsafe dispatch ahead of reconciliation', () => {
    expect(attemptReconciliationOutcome(undefined, reclaim)).toBe('not_found');
    expect(
      attemptReconciliationOutcome({ ...attempt, status: 'ready' }, reclaim),
    ).toBe('not_running');
    expect(
      attemptReconciliationOutcome(attempt, {
        ...reclaim,
        expectedFenceToken: 4,
      }),
    ).toBe('fence_conflict');
    for (const leaseExpired of [false, null])
      expect(
        attemptReconciliationOutcome({ ...attempt, leaseExpired }, reclaim),
      ).toBe('lease_active');
    const unsafe = {
      ...attempt,
      sideEffectClass: 'unsafe',
      dispatchMarkedAt: new Date(),
    };
    expect(attemptReconciliationOutcome(unsafe, reclaim)).toBe(
      'reclaim_unsafe',
    );
    expect(
      attemptReconciliationOutcome(unsafe, {
        ...reclaim,
        action: 'outcome_unknown',
      }),
    ).toBe('marked_unknown');
    expect(attemptReconciliationOutcome(attempt, reclaim)).toBe('reclaimed');
    expect(
      attemptReconciliationOutcome(attempt, { ...reclaim, dryRun: true }),
    ).toBe('would_reclaim');
    expect(
      attemptReconciliationOutcome(unsafe, {
        ...reclaim,
        action: 'outcome_unknown',
        dryRun: true,
      }),
    ).toBe('would_mark_unknown');
  });
  it('records evidence only for an unknown outcome', () => {
    expect(evidenceOutcome(undefined)).toBe('not_found');
    expect(evidenceOutcome('succeeded')).toBe('not_unknown');
    expect(evidenceOutcome('outcome_unknown')).toBe('evidence_recorded');
  });
  it('only resumes due nonterminal work and never cancels it twice', () => {
    const due = { dueNodeCount: 1, dueWait: false, dryRun: false };
    for (const status of [
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
    ]) {
      expect(resumeOutcome(status, due)).toBe('terminal');
      expect(cancellationOutcome({ status, cancelRequested: false }, due)).toBe(
        'terminal',
      );
    }
    expect(resumeOutcome('waiting', { ...due, dueNodeCount: 0 })).toBe(
      'not_due',
    );
    expect(resumeOutcome('waiting', due)).toBe('resumed');
    expect(resumeOutcome('waiting', { ...due, dryRun: true })).toBe(
      'would_resume',
    );
    expect(cancellationOutcome(undefined, due)).toBe('not_found');
    expect(
      cancellationOutcome({ status: 'running', cancelRequested: true }, due),
    ).toBe('already_requested');
    expect(
      cancellationOutcome({ status: 'running', cancelRequested: false }, due),
    ).toBe('cancel_requested');
  });
  it('requires a failed unpublished outbox event for redispatch', () => {
    expect(redispatchOutcome(undefined, { dryRun: false })).toBe('not_found');
    expect(
      redispatchOutcome(
        { publishedAt: new Date(), failedAt: null },
        { dryRun: false },
      ),
    ).toBe('already_published');
    expect(
      redispatchOutcome(
        { publishedAt: null, failedAt: null },
        { dryRun: false },
      ),
    ).toBe('not_failed');
    for (const dryRun of [true, false])
      expect(
        redispatchOutcome(
          { publishedAt: null, failedAt: new Date() },
          { dryRun },
        ),
      ).toBe(dryRun ? 'would_redispatch' : 'redispatched');
  });
  it('requires publication and matching replay workflow identity', () => {
    expect(
      triggerReconciliationOutcome(undefined, null, { dryRun: false }),
    ).toBe('not_found');
    expect(
      triggerReconciliationOutcome({ publishedVersionId: null }, null, {
        dryRun: false,
      }),
    ).toBe('not_published');
    expect(
      triggerReconciliationOutcome({ publishedVersionId: 'v' }, 'v', {
        dryRun: false,
      }),
    ).toBe('retry_requested');
    expect(runReplayOutcome(undefined, { dryRun: false })).toBe(
      'source_not_found',
    );
    expect(
      runReplayOutcome(
        { sourceWorkflowId: 'a', targetWorkflowId: null },
        { dryRun: false },
      ),
    ).toBe('version_not_executable');
    expect(
      runReplayOutcome(
        { sourceWorkflowId: 'a', targetWorkflowId: 'b' },
        { dryRun: false },
      ),
    ).toBe('workflow_mismatch');
    for (const dryRun of [true, false])
      expect(
        runReplayOutcome(
          { sourceWorkflowId: 'a', targetWorkflowId: 'a' },
          { dryRun },
        ),
      ).toBe(dryRun ? 'would_request' : 'replay_requested');
  });
});

describe('automaticReconciliationAction', () => {
  const at = new Date('2026-10-31T00:00:00.000Z');

  it.each([
    [at, 'unsafe', 'outcome_unknown'],
    [null, 'unsafe', 'reclaim'],
    [at, 'safe', 'reclaim'],
    [at, 'idempotent_with_key', 'reclaim'],
  ] as const)(
    'with dispatch %s and class %s asks for %s',
    (dispatchMarkedAt, sideEffectClass, action) => {
      expect(
        automaticReconciliationAction({ dispatchMarkedAt, sideEffectClass }),
      ).toBe(action);
    },
  );

  it('never asks for what the reconciler refuses', () => {
    for (const dispatchMarkedAt of [at, null])
      for (const sideEffectClass of ['safe', 'idempotent_with_key', 'unsafe'])
        expect(
          attemptReconciliationOutcome(
            {
              status: 'running',
              fenceToken: 3,
              leaseExpired: true,
              dispatchMarkedAt,
              sideEffectClass,
            },
            {
              expectedFenceToken: 3,
              action: automaticReconciliationAction({
                dispatchMarkedAt,
                sideEffectClass,
              }),
              dryRun: false,
            },
          ),
        ).not.toBe('reclaim_unsafe');
  });
});

describe('overdueDeliveryAction', () => {
  it.each([
    ['advance-workflow-run', 'running', undefined, 'replace'],
    ['advance-workflow-run', 'waiting', undefined, 'replace'],
    ['advance-workflow-run', 'queued', undefined, 'drop'],
    ['advance-workflow-run', 'succeeded', undefined, 'drop'],
    ['advance-workflow-run', undefined, undefined, 'drop'],
    ['execute-node-attempt', 'running', 'ready', 'replace'],
    ['execute-node-attempt', 'running', 'running', 'drop'],
    ['execute-node-attempt', 'running', 'succeeded', 'drop'],
    ['execute-node-attempt', 'canceled', 'ready', 'drop'],
  ] as const)(
    '%s on a %s run with a %s attempt: %s',
    (jobName, runStatus, attemptStatus, action) => {
      expect(overdueDeliveryAction({ jobName, runStatus, attemptStatus })).toBe(
        action,
      );
    },
  );
});
