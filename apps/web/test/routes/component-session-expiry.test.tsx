import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  createUserFixture,
  createWorkspaceFixture,
} from '../support/fixtures/identity';
it.each(['first read', 'refetch'] as const)(
  'recovers a component-owned expired session on %s with a safe return path',
  async (when) => {
    const user = createUserFixture(),
      workspace = createWorkspaceFixture();
    let expired = when === 'first read';
    let checked = false;
    const refusal = () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Authentication required',
          status: 401,
          code: 'auth.unauthenticated',
          requestId: 'component-expiry',
        },
        {
          status: 401,
          headers: { 'content-type': 'application/problem+json' },
        },
      );
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () => {
        if (checked && expired) return refusal();
        checked = true;
        return HttpResponse.json(user);
      }),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [workspace], nextCursor: null }),
      ),
      http.get(
        'http://pertexo.test/v1/workspaces/:workspaceId/variables',
        () =>
          expired
            ? refusal()
            : HttpResponse.json({ revision: 1, values: {}, descriptions: {} }),
      ),
    );
    const path = `/w/${workspace.id}/settings/variables`;
    const view = renderApp(path);
    if (when === 'refetch') {
      await screen.findByText('No workspace variables configured.');
      expired = true;
      await view.queryClient.refetchQueries({
        predicate: (query) => query.queryKey.includes('variables'),
      });
    }
    await waitFor(() => {
      expect(view.router.state.location.pathname).toBe('/login');
    });
    expect(view.router.state.location.search).toMatchObject({ returnTo: path });
  },
);

it('does not end the application session for another API 401 code', async () => {
  const user = createUserFixture(),
    workspace = createWorkspaceFixture();
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [workspace], nextCursor: null }),
    ),
    http.get('http://pertexo.test/v1/workspaces/:workspaceId/variables', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Provider credentials refused',
          status: 401,
          code: 'connection.credential_rejected',
          requestId: 'provider-refusal',
        },
        {
          status: 401,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    ),
  );
  const path = `/w/${workspace.id}/settings/variables`;
  const view = renderApp(path);
  await screen.findByText('Workspace variables couldn’t be loaded. Try again.');
  expect(view.router.state.location.pathname).toBe(path);
  expect(
    screen.queryByText('Your session ended. Sign in again.'),
  ).not.toBeInTheDocument();
});
