import { QueryClient } from '@tanstack/react-query';
import { beforeEach, expect, it } from 'vitest';
import { workspaceKeys } from '@/features/workspaces/data/workspaces.queries';
import { knownWorkspaceName } from '@/features/workspaces/model/last-workspace';
import { createWorkspaceFixture } from '../../support/fixtures/identity';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspace = createWorkspaceFixture({ name: 'Control Operations' });

beforeEach(() => {
  localStorage.clear();
});

// While a workspace opens, its name comes from workspaces this tab already
// loaded, else from the one opened last in this browser.
it('names a workspace this tab already listed', () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(workspaceKeys.accessible(userId), [workspace]);
  expect(knownWorkspaceName(queryClient, workspace.id)).toBe(
    'Control Operations',
  );
});

it('falls back to the workspace opened last in this browser', () => {
  localStorage.setItem(
    'pertexo:last-workspace',
    JSON.stringify({
      userId,
      workspaceId: workspace.id,
      workspaceName: 'Remembered Ops',
    }),
  );
  expect(knownWorkspaceName(new QueryClient(), workspace.id)).toBe(
    'Remembered Ops',
  );
  expect(knownWorkspaceName(new QueryClient(), 'another')).toBeUndefined();
});
