import { describe, expect, it } from 'vitest';
import { CallableInputInvalidError } from '@pertexo/workflow-model';
import {
  errorWorkflowRefusal,
  transitionStartsErrorWorkflow,
} from '../../../src/runs/error-workflows/error-workflow-admission.js';
import { ErrorWorkflowVersionUnavailableError } from '../../../src/runs/error-workflows/error-workflow.errors.js';
import {
  WorkflowAlreadyRunningError,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '../../../src/runs/commands/acceptance/run-admission.errors.js';

const plan = (...names: string[]) => ({
  events: names.map((name) => ({ name })) as never,
});

describe('error workflow rules', () => {
  it('starts an error workflow for a failed, timed-out or unknown run', () => {
    for (const name of ['run.failed', 'run.timed_out', 'run.outcome_unknown'])
      expect(
        transitionStartsErrorWorkflow({
          cancellationRequested: false,
          plan: plan('node.completed', name),
        }),
      ).toBe(true);
  });

  it('starts none for a cancelled run or a transition that does not end in failure', () => {
    expect(
      transitionStartsErrorWorkflow({
        cancellationRequested: true,
        plan: plan('run.failed'),
      }),
    ).toBe(false);
    expect(
      transitionStartsErrorWorkflow({
        cancellationRequested: false,
        plan: plan('run.succeeded'),
      }),
    ).toBe(false);
  });

  it('stores the refusal each admission failure stands for', () => {
    expect(errorWorkflowRefusal(new WorkflowAlreadyRunningError())).toBe(
      'concurrency_limit',
    );
    expect(errorWorkflowRefusal(new WorkspaceRunQuotaExceededError())).toBe(
      'queue_full',
    );
    expect(errorWorkflowRefusal(new WorkspaceRunAdmissionDeniedError())).toBe(
      'workspace_unavailable',
    );
    expect(
      errorWorkflowRefusal(new ErrorWorkflowVersionUnavailableError()),
    ).toBe('invalid_target');
    expect(errorWorkflowRefusal(new CallableInputInvalidError('missing'))).toBe(
      'invalid_target',
    );
    expect(errorWorkflowRefusal(new Error('lost'))).toBeUndefined();
  });
});
