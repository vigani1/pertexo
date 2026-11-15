import {
  approvalOutputSchema,
  formSubmissionSchema,
  type parseFormValues,
} from '@pertexo/workflow-model';
import type {
  PendingTaskDecision,
  PendingTaskSubmission,
} from './pending-task-response.types.js';

export type TaskResponse =
  | (PendingTaskDecision & Readonly<{ kind: 'approval' }>)
  | (PendingTaskSubmission & Readonly<{ kind: 'input_request' }>);
type SubmittedValues = ReturnType<typeof parseFormValues>;

/** An approval stores its decision; a form stores that it was submitted. */
export function taskResponseStatus(input: TaskResponse) {
  return input.kind === 'approval' ? input.decision : 'submitted';
}

/** The idempotent command one responder's response to one task claims. */
export function taskResponseCommand(input: TaskResponse) {
  return {
    workspaceId: input.workspaceId,
    operation:
      input.kind === 'approval' ? 'pending.task.decide' : 'pending.task.submit',
    scope: `${input.actorId}:${input.taskId}`,
    idempotencyKey: input.idempotencyKey,
  };
}

/** What the command's request hash covers: the decision and comment, or the parsed values. */
export function taskResponseRequest(
  input: TaskResponse,
  submitted: SubmittedValues | undefined,
) {
  return input.kind === 'approval'
    ? { decision: input.decision, comment: approvalComment(input) }
    : { values: submitted };
}

export function taskResponseOutput(
  input: TaskResponse,
  {
    values,
    now,
    display_name,
  }: Readonly<{
    values: SubmittedValues | undefined;
    now: Date;
    display_name: string;
  }>,
) {
  return input.kind === 'approval'
    ? approvalOutputSchema.parse({
        decision: input.decision,
        comment: approvalComment(input),
        decidedBy: input.actorId,
        decidedByName: display_name,
        decidedAt: now.toISOString(),
      })
    : formSubmissionSchema.parse({
        values,
        submittedBy: input.actorId,
        submittedAt: now.toISOString(),
      });
}

function approvalComment(input: PendingTaskDecision) {
  return input.comment === '' ? null : (input.comment ?? null);
}
