import { expect, it } from 'vitest';
import { ApiError } from '@/lib/api/api-error';
import { commandErrorMessage } from '@/features/workflow-publish/mutations/command-utils';

it('does not describe native draft unavailability as a changed draft', () => {
  const error = new ApiError({
    kind: 'problem',
    message: 'unavailable',
    status: 409,
    problem: {
      type: 'urn:pertexo:problem:workflow.draft_operation_unavailable',
      title: 'Workflow draft operation unavailable',
      status: 409,
      code: 'workflow.draft_operation_unavailable',
      requestId: 'request-123',
    },
  });
  expect(commandErrorMessage(error, 'checking')).toBe(
    'This operation is not enabled for native workflow drafts.',
  );
});
