import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { ApiTokenMetadata } from '@pertexo/contracts';
import { RevokeTokenDialog } from '@/features/api-tokens/components/revoke-dialog';
import { createApiClient } from '@/lib/api/client';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const token: ApiTokenMetadata = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  workspaceId,
  name: 'Build runner',
  scopes: ['run:read'],
  status: 'active',
  createdAt: '2026-10-14T10:00:00.000Z',
  expiresAt: '2026-11-13T10:00:00.000Z',
  revokedAt: null,
  lastUsedAt: null,
};

it('closes once when Close follows a revocation it couldn’t confirm', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response('lost', { status: 502 }));
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RevokeTokenDialog
        apiClient={createApiClient({ fetch, readCsrfToken: () => 'csrf' })}
        userId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        workspaceId={workspaceId}
        token={token}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Revoke token' }));
  expect(
    await screen.findByText(/Revocation could not be confirmed/u),
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
