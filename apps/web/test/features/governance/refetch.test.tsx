import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { GovernanceSettings } from '@/features/governance/components/settings';
import { governanceQueryOptions } from '@/features/governance/data/audit.queries';
import { createApiClient } from '@/lib/api/client';
import {
  ownerWorkspace,
  userId,
  workspaceId,
} from '../../support/fixtures/team';

it('keeps unsaved governance choices mounted across a failed background refresh and retry', async () => {
  let failing = false;
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const apiClient = createApiClient({
    fetch: () =>
      failing
        ? Promise.reject(new TypeError('Network unavailable'))
        : Promise.resolve(
            new Response(
              JSON.stringify({
                revision: 1,
                auditRetentionDays: 365,
                requirePublishApproval: false,
              }),
              { headers: { 'Content-Type': 'application/json' } },
            ),
          ),
    readCsrfToken: () => undefined,
  });
  const scope = { apiClient, userId, workspaceId };
  const workspace: AccessibleWorkspace = {
    ...ownerWorkspace,
    role: 'owner',
    status: 'active',
    capabilities: ['governance:manage'],
  };
  render(
    <QueryClientProvider client={cache}>
      <GovernanceSettings scope={scope} workspace={workspace} />
    </QueryClientProvider>,
  );
  const actor = userEvent.setup();
  const retention = await screen.findByLabelText('Keep audit events (days)');
  const approval = screen.getByRole('checkbox', {
    name: 'Require approval to publish',
  });
  await actor.clear(retention);
  await actor.type(retention, '730');
  await actor.click(approval);
  failing = true;
  await act(async () => {
    await cache.invalidateQueries({
      queryKey: governanceQueryOptions(scope).queryKey,
    });
  });
  await screen.findByText(
    /Governance settings could not be loaded|Couldn’t refresh/u,
  );
  expect(screen.queryByLabelText('Keep audit events (days)')).toBe(retention);
  expect(retention).toHaveValue(730);
  expect(
    screen.getByRole('checkbox', { name: 'Require approval to publish' }),
  ).toBe(approval);
  expect(approval).toBeChecked();
  expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t refresh');
  failing = false;
  await actor.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => {
    expect(screen.queryByText(/Couldn’t refresh/u)).toBeNull();
  });
  expect(screen.getByLabelText('Keep audit events (days)')).toBe(retention);
  expect(retention).toHaveValue(730);
  expect(approval).toBeChecked();
});
