import { describe, expect, it } from 'vitest';
import {
  evidenceOutcome,
  resumeOutcome,
  cancellationOutcome,
  redispatchOutcome,
  triggerReconciliationOutcome,
  runReplayOutcome,
} from '../../src/operator/handlers/operator-command-decisions.js';
describe('operator decisions', () => {
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
