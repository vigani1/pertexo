import { expect, it } from 'vitest';
import { ApiError } from '@/lib/api/error';
import { commandErrorMessage } from '@/features/workflow-publish/data/mutations/command-utils';
import type { ApiProblemCode, ApiProblemIssue } from '@pertexo/contracts';
function failure(code: ApiProblemCode, errors: readonly ApiProblemIssue[]) {
  return new ApiError({
    kind: 'problem',
    message: 'Request failed',
    status: 422,
    problem: {
      type: 'about:blank',
      title: 'Invalid workflow',
      status: 422,
      code,
      requestId: 'test',
      errors,
    },
  });
}
it('shows the server finding for a publication-only validation failure', () => {
  const message =
    'Workspace variable RATE does not exist. Add it in Settings → Variables.';
  expect(
    commandErrorMessage(
      failure('workflow.invalid', [
        { path: 'nodes.rate', code: 'invalid_mapping', message },
      ]),
      'publishing',
    ),
  ).toBe(message);
});
it('keeps compile setup findings first and unrelated validation errors generic', () => {
  const errors = [
    { path: 'nodes.rate', code: 'invalid_mapping', message: 'Missing RATE' },
    {
      path: 'nodes.http',
      code: 'executable_invalid',
      message: 'Configure the HTTP step.',
    },
  ];
  expect(
    commandErrorMessage(failure('workflow.invalid', errors), 'publishing'),
  ).toBe('Configure the HTTP step.');
  expect(
    commandErrorMessage(
      failure('request.invalid', [
        { path: 'input', code: 'invalid_value', message: 'Keep this generic' },
      ]),
      'this run',
    ),
  ).toBe(
    'This run was stopped by issues in the workflow. Fix them and try again.',
  );
  expect(
    commandErrorMessage(failure('workflow.invalid', []), 'publishing'),
  ).toBe(
    'Publishing was stopped by issues in the workflow. Fix them and try again.',
  );
});
