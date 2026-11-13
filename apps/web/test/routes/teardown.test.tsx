import { http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import { afterAll, expect, it, vi } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderLoadedApp } from '../support/render-app';
import {
  createUserFixture,
  createWorkspaceFixture,
} from '../support/fixtures/identity';

// The next page's code arrives slowly, so its navigation is still loading,
// with its pending UI timed, when the test ends.
vi.mock('@/routes/workspace/team', async (original) => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return original();
});

it('leaves nothing of an unfinished navigation running after the test', async () => {
  const user = createUserFixture(),
    workspace = createWorkspaceFixture();
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [workspace], nextCursor: null }),
    ),
    http.get('http://pertexo.test/v1/workspaces/:workspaceId/variables', () =>
      HttpResponse.json({ revision: 1, values: {}, descriptions: {} }),
    ),
    http.get('http://pertexo.test/v1/workspaces/:workspaceId/members', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('http://pertexo.test/v1/workspaces/:workspaceId/invitations', () =>
      HttpResponse.json({
        items: [],
        nextCursor: null,
        issuanceAvailable: true,
      }),
    ),
  );
  const view = await renderLoadedApp(`/w/${workspace.id}/settings/variables`);
  await screen.findByText('No workspace variables configured.');
  void view.router.navigate({
    to: '/w/$workspaceId/team',
    params: { workspaceId: workspace.id },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(view.router.state.status).toBe('pending');
});

// Stands in for the environment closing: from here on there is no window,
// so a router timer or commit that reaches React fails this file with an
// unhandled "window is not defined".
afterAll(async () => {
  const kept = globalThis.window;
  Reflect.deleteProperty(globalThis, 'window');
  await new Promise((resolve) => setTimeout(resolve, 700));
  globalThis.window = kept;
});
