import { resetReadMocks } from './setup';

import { getWorkflowOrganizationPage } from '@/features/workflows/data/organization/api';

import { workflowOrganizationKeys } from '@/features/workflows/data/organization/queries';

import { act, screen, waitFor } from '@testing-library/react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userId, workspaceId } from '../../list/fixtures';

import { deferred, page, ready, setup } from './fixture';

vi.mock('@/features/workflows/data/organization/api', async (original) => ({
  ...(await original<object>()),
  getWorkflowOrganizationPage: vi.fn(),
  getWorkflowFolders: vi.fn(),
  getWorkflowTagsPage: vi.fn(),
  sendWorkflowOrganizationCommand: vi.fn(),
}));

vi.mock('@/features/auth/session/identity.public', async (original) => ({
  ...(await original<object>()),
  assertSessionIdentity: vi.fn(),
}));

vi.mock('@/features/workspaces/queries.public', async (original) => ({
  ...(await original<object>()),
  getAllAccessibleWorkspaces: vi.fn(),
}));

beforeEach(resetReadMocks);

describe('organization reads without a command dialog', () => {
  it.each(['actor', 'workspace'] as const)(
    'an old scoped late reply cannot affect a new %s read owner',
    async (changing) => {
      const view = setup();
      await ready();
      const held = deferred<typeof page>();
      vi.mocked(getWorkflowOrganizationPage).mockReturnValueOnce(held.promise);
      act(() => {
        void view.client.invalidateQueries({
          queryKey: [
            ...workflowOrganizationKeys.scope(userId, workspaceId),
            'list',
          ],
        });
      });
      await waitFor(() => {
        expect(getWorkflowOrganizationPage).toHaveBeenCalledTimes(2);
      });
      const oldSignal = vi.mocked(getWorkflowOrganizationPage).mock
        .calls[1]?.[3];
      const current = {
        ...page,
        items: page.items.map((item) => ({
          ...item,
          workflow: { ...item.workflow, name: 'Current authorized workflow' },
          organization: { ...item.organization, isFavorite: false },
        })),
      };
      vi.mocked(getWorkflowOrganizationPage).mockResolvedValue(current);
      view.rerenderScope(
        changing === 'actor' ? 'other-actor' : userId,
        changing === 'workspace' ? 'other-workspace' : workspaceId,
      );
      await screen.findByText('Current authorized workflow');
      expect(oldSignal?.aborted).toBe(true);
      act(() => {
        held.resolve(page);
      });
      expect(
        screen.queryByText('Protected workflow Private favorite'),
      ).not.toBeInTheDocument();
      expect(screen.getByText('Current authorized workflow')).toBeVisible();
    },
  );
});
