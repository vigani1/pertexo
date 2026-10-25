import { DomainEntry } from '@/features/federation/components/domains/entry';
import { createApiClient } from '@/lib/api/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { readRequestJson } from '../../support/request';
import { organization, providerId, userId, workspaceId } from './fixtures';

it('retains the reviewed SSO action and revision when settings refresh while the confirmation is open', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        type: 'urn:pertexo:problem:workspace.conflict',
        title: 'Settings changed',
        status: 409,
        code: 'workspace.conflict',
        requestId: 'sso-review-conflict',
        detail: 'Sign-in settings changed. Reload before saving.',
      }),
      {
        status: 409,
        headers: { 'content-type': 'application/problem+json' },
      },
    ),
  );
  const apiClient = createApiClient({
    fetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  const scope = { apiClient, userId, workspaceId },
    cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const original = organization.domains[0];
  if (original === undefined) throw new Error('Missing domain');
  const ready = {
    ...original,
    checks: [
      { providerId, providerRevision: 1, testedAt: '2026-10-18T00:00:00.000Z' },
    ],
  };
  const view = render(
    <QueryClientProvider client={cache}>
      <DomainEntry
        scope={scope}
        organization={organization}
        domain={ready}
        editable
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Require SSO' }));
  const changed = { ...organization, revision: 2 };
  view.rerender(
    <QueryClientProvider client={cache}>
      <DomainEntry
        scope={scope}
        organization={changed}
        domain={{ ...ready, requireSso: true }}
        editable
      />
    </QueryClientProvider>,
  );
  const dialog = screen.getByRole('dialog');
  expect(
    within(dialog).getByText('Require organization SSO?', { exact: true }),
  ).toBeVisible();
  await user.click(within(dialog).getByRole('button', { name: 'Require SSO' }));
  await waitFor(() => {
    expect(fetch).toHaveBeenCalledOnce();
  });
  const body = fetch.mock.calls[0]?.[1]?.body;

  expect(
    readRequestJson({ body, missingMessage: 'Missing confirmation request' }),
  ).toEqual({
    required: true,
    expectedRevision: 1,
  });
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Sign-in settings changed. Reload before saving.',
  );
});
