import { describe, expect, it } from 'vitest';
import { CallableInputInvalidError } from '@pertexo/workflow-model';
import {
  callAdmissionRefusal,
  callParentWaiting,
} from '../../../src/runs/calls/acceptance.js';
import { WorkflowCallRefusedError } from '../../../src/runs/calls/workflow-call.errors.js';
import {
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '../../../src/runs/commands/acceptance/run-admission.errors.js';

const waitingParent = {
  status: 'waiting',
  cancel_requested_at: null,
  deadline_expired: false,
  has_wait: true,
  has_ordinary_work: false,
};

describe('workflow call acceptance rules', () => {
  it('takes a child only while the parent waits on the call alone', () => {
    expect(callParentWaiting(waitingParent)).toBe(true);
    expect(callParentWaiting({ ...waitingParent, status: 'running' })).toBe(
      true,
    );
    expect(
      callParentWaiting({ ...waitingParent, deadline_expired: null }),
    ).toBe(true);
  });

  it('refuses a parent that finished, was cancelled, expired or has other work', () => {
    expect(callParentWaiting({ ...waitingParent, status: 'failed' })).toBe(
      false,
    );
    expect(
      callParentWaiting({ ...waitingParent, cancel_requested_at: new Date() }),
    ).toBe(false);
    expect(
      callParentWaiting({ ...waitingParent, deadline_expired: true }),
    ).toBe(false);
    expect(callParentWaiting({ ...waitingParent, has_wait: false })).toBe(
      false,
    );
    expect(
      callParentWaiting({ ...waitingParent, has_ordinary_work: true }),
    ).toBe(false);
  });

  it('turns admission failures into the refusal stored on the call', () => {
    expect(
      callAdmissionRefusal(
        new WorkflowCallRefusedError('call_deadline_expired'),
      ),
    ).toBe('call_deadline_expired');
    expect(callAdmissionRefusal(new CallableInputInvalidError('missing'))).toBe(
      'call_input_invalid',
    );
    expect(callAdmissionRefusal(new WorkspaceRunQuotaExceededError())).toBe(
      'call_target_capacity_exceeded',
    );
    expect(callAdmissionRefusal(new WorkspaceRunAdmissionDeniedError())).toBe(
      'call_target_unavailable',
    );
  });

  it('leaves every other failure to be rethrown', () => {
    expect(callAdmissionRefusal(new Error('lost'))).toBeUndefined();
  });
});
