import { describe, expect, it } from 'vitest';
import {
  taskResponseCommand,
  taskResponseOutput,
  taskResponseRequest,
  taskResponseStatus,
  type TaskResponse,
} from '../../../src/runs/pending-tasks/responses/response.js';

const scope = {
  workspaceId: 'workspace-1',
  actorId: '00000000-0000-4000-8000-0000000000a1',
  taskId: 'task-1',
  idempotencyKey: 'key-1',
};
const approval: TaskResponse = {
  ...scope,
  kind: 'approval',
  decision: 'approved',
  comment: '',
};
const submission: TaskResponse = {
  ...scope,
  kind: 'input_request',
  values: { name: 'Ada' },
};
const now = new Date('2026-11-15T10:00:00.000Z');

describe('pending task responses', () => {
  it('stores the decision for an approval and "submitted" for a form', () => {
    expect(taskResponseStatus(approval)).toBe('approved');
    expect(taskResponseStatus({ ...approval, decision: 'rejected' })).toBe(
      'rejected',
    );
    expect(taskResponseStatus(submission)).toBe('submitted');
  });

  it('claims one command per responder and task', () => {
    expect(taskResponseCommand(approval)).toEqual({
      workspaceId: 'workspace-1',
      operation: 'pending.task.decide',
      scope: '00000000-0000-4000-8000-0000000000a1:task-1',
      idempotencyKey: 'key-1',
    });
    expect(taskResponseCommand(submission).operation).toBe(
      'pending.task.submit',
    );
  });

  it('hashes an empty comment as no comment, and a form by its parsed values', () => {
    expect(taskResponseRequest(approval, undefined)).toEqual({
      decision: 'approved',
      comment: null,
    });
    expect(taskResponseRequest(submission, { name: 'Ada' })).toEqual({
      values: { name: 'Ada' },
    });
  });

  it('records who decided, under which name and when', () => {
    expect(
      taskResponseOutput(
        { ...approval, comment: 'Looks right' },
        { values: undefined, now, display_name: 'Ada Lovelace' },
      ),
    ).toEqual({
      decision: 'approved',
      comment: 'Looks right',
      decidedBy: '00000000-0000-4000-8000-0000000000a1',
      decidedByName: 'Ada Lovelace',
      decidedAt: '2026-11-15T10:00:00.000Z',
    });
    expect(
      taskResponseOutput(submission, {
        values: { name: 'Ada' },
        now,
        display_name: 'Ada Lovelace',
      }),
    ).toEqual({
      values: { name: 'Ada' },
      submittedBy: '00000000-0000-4000-8000-0000000000a1',
      submittedAt: '2026-11-15T10:00:00.000Z',
    });
  });
});
