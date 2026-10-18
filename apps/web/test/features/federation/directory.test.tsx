import type { ReactNode } from 'react';
import { deferred, ownerWorkspace } from '../../support/fixtures/team';
// @vitest-environment-options {"url":"https://pertexo.test"}
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { accessibleWorkspaceSchema } from '@pertexo/contracts';
import type {
  DirectorySettings,
  DirectoryAdoptionPreview,
} from '@pertexo/contracts';
import { NotificationsProvider } from '@/components/ui/toast';
import { DirectoryCredentialDialog } from '@/features/federation/components/directory/credential-dialog';
import { DirectoryMappingsEditor } from '@/features/federation/components/directory/mappings';
import { DirectoryPanel } from '@/features/federation/components/directory/panel';
import { DirectoryAdoptionDialog } from '@/features/federation/components/directory/adoption-dialog';
import {
  adoptionQueryOptions,
  directoryQueryOptions,
} from '@/features/federation/data/directory.queries';
import { createApiClient } from '@/lib/api/client';
import { json, organization, workspaceId, userId } from './fixtures';

const groupId = '11111111-1111-4111-8111-111111111111',
  credentialId = '22222222-2222-4222-8222-222222222222',
  directoryUserId = '33333333-3333-4333-8333-333333333333';
const directory: DirectorySettings = {
  organizationId: organization.id,
  controlWorkspaceId: workspaceId,
  canManage: true,
  revision: 1,
  counts: { users: 1, activeUsers: 1, groups: 1 },
  credentials: [],
  groups: [{ id: groupId, displayName: 'Builders', memberCount: 1 }],
  mappings: [{ groupId, workspaceId, role: 'builder', priority: 0 }],
};
function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>(),
    cache = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  const apiClient = createApiClient({
    fetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  return {
    fetch,
    cache,
    scope: { apiClient, userId, workspaceId },
    wrapper: ({ children }: Readonly<{ children: ReactNode }>) => (
      <QueryClientProvider client={cache}>
        <NotificationsProvider>{children}</NotificationsProvider>
      </QueryClientProvider>
    ),
  };
}
describe('directory management and reviewed commands', () => {
  it('shows the bearer once, requires saving it, and keeps it out of both Query caches', async () => {
    const f = fixture(),
      onClose = vi.fn(),
      onRefresh = vi.fn(),
      secret = 'only-in-this-mounted-dialog-private-material';
    f.fetch.mockResolvedValue(
      json({
        replayed: false,
        secret,
        credential: {
          id: credentialId,
          name: 'Company directory',
          createdAt: '2026-10-18T00:00:00.000Z',
          revokedAt: null,
          lastUsedAt: null,
        },
      }),
    );
    render(
      <DirectoryCredentialDialog
        scope={f.scope}
        revision={1}
        onClose={onClose}
        onRefresh={onRefresh}
      />,
      { wrapper: f.wrapper },
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText('Credential name'),
      'Company directory',
    );
    await user.click(screen.getByRole('button', { name: 'Create credential' }));
    expect(
      await screen.findByLabelText('Provisioning bearer credential'),
    ).toHaveValue(secret);
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(f.cache.getMutationCache().getAll()).toHaveLength(0);
    expect(
      JSON.stringify(
        f.cache
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(secret);
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('checkbox', { name: 'I’ve saved this credential' }),
    );
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledOnce();
  });
  it('keeps a newly shown bearer mounted when the background settings refresh fails', async () => {
    const f = fixture();
    f.cache.setQueryData(directoryQueryOptions(f.scope).queryKey, directory);
    f.fetch.mockImplementation((url, request) => {
      if (request?.method === 'POST')
        return Promise.resolve(
          json({
            replayed: false,
            secret: 'shown-once-during-a-refresh-failure',
            credential: {
              id: credentialId,
              name: 'Refresh-safe directory',
              createdAt: '2026-10-18T00:00:00.000Z',
              revokedAt: null,
              lastUsedAt: null,
            },
          }),
        );
      if (typeof url === 'string' && url.includes('/people?'))
        return Promise.resolve(json({ items: [], nextCursor: null }));
      return Promise.reject(new TypeError('Network unavailable'));
    });
    render(
      <DirectoryPanel
        scope={f.scope}
        organization={organization}
        workspace={accessibleWorkspaceSchema.parse(ownerWorkspace)}
      />,
      { wrapper: f.wrapper },
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Create provisioning credential' }),
    );
    await user.type(
      screen.getByLabelText('Credential name'),
      'Refresh-safe directory',
    );
    await user.click(screen.getByRole('button', { name: 'Create credential' }));
    await screen.findByText('Directory settings could not be loaded.');
    expect(screen.getByLabelText('Provisioning bearer credential')).toHaveValue(
      'shown-once-during-a-refresh-failure',
    );
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
  });
  it('explains an uncertain creation instead of offering a second credential or caching its response', async () => {
    const f = fixture();
    f.fetch.mockRejectedValue(new TypeError('Network unavailable'));
    render(
      <DirectoryCredentialDialog
        scope={f.scope}
        revision={1}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
      />,
      { wrapper: f.wrapper },
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText('Credential name'),
      'Uncertain directory',
    );
    await user.click(screen.getByRole('button', { name: 'Create credential' }));
    expect(await screen.findByText(/Check the list and revoke/u)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Create credential' }),
    ).not.toBeInTheDocument();
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.cache.getMutationCache().getAll()).toHaveLength(0);
  });
  it('follows refreshed mappings until a person starts editing', () => {
    const f = fixture();
    const view = render(
      <DirectoryMappingsEditor
        scope={f.scope}
        settings={directory}
        organization={organization}
        editable
      />,
      { wrapper: f.wrapper },
    );
    const changed = {
      ...directory,
      revision: 2,
      mappings: directory.mappings.map((mapping) => ({
        ...mapping,
        role: 'viewer' as const,
      })),
    };
    view.rerender(
      <DirectoryMappingsEditor
        scope={f.scope}
        settings={changed}
        organization={organization}
        editable
      />,
    );
    expect(
      screen.getByRole('combobox', { name: 'Role for Builders' }),
    ).toHaveTextContent('viewer');
    expect(
      screen.queryByRole('button', { name: 'Load current mappings' }),
    ).not.toBeInTheDocument();
  });
  it('preserves mapping edits across refreshes and requires an explicit reload for a new revision', async () => {
    const f = fixture(),
      view = render(
        <DirectoryMappingsEditor
          scope={f.scope}
          settings={directory}
          organization={organization}
          editable
        />,
        { wrapper: f.wrapper },
      );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('combobox', { name: 'Role for Builders' }),
    );
    await user.click(await screen.findByRole('option', { name: 'operator' }));
    const changed = {
      ...directory,
      revision: 2,
      mappings: [
        {
          ...directory.mappings[0],
          groupId,
          workspaceId,
          priority: 0,
          role: 'viewer' as const,
        },
      ],
    };
    view.rerender(
      <DirectoryMappingsEditor
        scope={f.scope}
        settings={changed}
        organization={organization}
        editable
      />,
    );
    expect(
      screen.getByRole('combobox', { name: 'Role for Builders' }),
    ).toHaveTextContent('operator');
    expect(
      screen.getByRole('button', { name: 'Save group mappings' }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole('button', { name: 'Load current mappings' }),
    );
    expect(
      screen.getByRole('combobox', { name: 'Role for Builders' }),
    ).toHaveTextContent('viewer');
    expect(
      screen.getByRole('button', { name: 'Save group mappings' }),
    ).toBeEnabled();
  });
  it('keeps the exact reviewed adoption after a refetch and prevents dismissing a pending decision', async () => {
    const f = fixture(),
      onClose = vi.fn(),
      input = { directoryUserId, targetWorkspaceId: workspaceId };
    const review: Extract<DirectoryAdoptionPreview, { eligible: true }> = {
      eligible: true,
      displayName: 'Existing builder',
      currentRole: 'builder',
      command: {
        ...input,
        expectedRevision: 1,
        directoryRevision: 2,
        membershipRevision: 1,
        role: 'operator',
      },
    };
    const pending = deferred<Response>();
    f.fetch.mockImplementation((_url, request) =>
      request?.method === 'POST'
        ? pending.promise
        : Promise.resolve(json(review)),
    );
    render(
      <DirectoryAdoptionDialog
        scope={f.scope}
        input={input}
        onClose={onClose}
      />,
      { wrapper: f.wrapper },
    );
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Adopt this membership' });
    const refreshed: DirectoryAdoptionPreview = {
      ...review,
      command: { ...review.command, expectedRevision: 2, role: 'admin' },
    };
    f.cache.setQueryData(
      adoptionQueryOptions(f.scope, input).queryKey,
      () => refreshed,
    );
    await user.click(
      screen.getByRole('button', { name: 'Adopt this membership' }),
    );
    await waitFor(() => {
      expect(
        f.fetch.mock.calls.some(([, request]) => request?.method === 'POST'),
      ).toBe(true);
    });
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    const request = f.fetch.mock.calls.find(
      ([, options]) => options?.method === 'POST',
    )?.[1];
    if (typeof request?.body !== 'string')
      throw new Error('Missing JSON command');
    const sent: unknown = JSON.parse(request.body);
    expect(sent).toEqual(review.command);
    pending.resolve(json({ changed: true }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });
  });
});
