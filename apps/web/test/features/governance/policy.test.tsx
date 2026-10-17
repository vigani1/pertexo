import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { PublicationPolicy } from '@/features/governance/components/publication-policy';
import { createApiClient } from '@/lib/api/client';
it('labels the approval policy and sends a revision-fenced policy change', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        revision: 2,
        auditRetentionDays: 365,
        requirePublishApproval: true,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    ),
  );
  const apiClient = createApiClient({
    fetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  const scope = {
    apiClient,
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PublicationPolicy
        scope={scope}
        snapshot={{
          revision: 1,
          auditRetentionDays: 365,
          requirePublishApproval: false,
        }}
        editable
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const checkbox = screen.getByRole('checkbox', {
    name: 'Require approval to publish',
  });
  await user.click(checkbox);
  expect(checkbox).toBeChecked();
  await user.click(
    screen.getByRole('button', { name: 'Save publishing policy' }),
  );
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Publishing policy saved.',
  );
  const body = fetch.mock.calls[0]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON request body');
  expect(JSON.parse(body) as unknown).toEqual({
    expectedRevision: 1,
    requirePublishApproval: true,
  });
});
