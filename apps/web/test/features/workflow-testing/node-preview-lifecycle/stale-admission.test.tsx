import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { ApiError } from '@/lib/api/error';
import { apiClientFor, panel } from './fixture';

it('tells a tester to refresh and prepare again when a concurrent save wins late admission', async () => {
  const apiClient = apiClientFor(() =>
    Promise.reject(
      new ApiError({
        kind: 'problem',
        message: 'Draft changed',
        status: 409,
        problem: {
          type: 'urn:pertexo:problem:workflow.revision_conflict',
          title: 'Workflow draft changed',
          status: 409,
          code: 'workflow.revision_conflict',
          detail:
            'The saved draft changed. Refresh the draft and prepare the step test again.',
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      }),
    ),
  );
  render(panel({ apiClient, nodeId: 'node-a' }));
  const user = userEvent.setup();
  await user.click(
    screen.getByRole('switch', {
      name: 'I understand this test runs for real',
    }),
  );
  await user.click(screen.getByRole('button', { name: 'Run test' }));
  expect(
    await screen.findByText(
      'The saved draft changed. Refresh the draft and prepare the step test again.',
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Retry same test' }),
  ).not.toBeInTheDocument();
});
