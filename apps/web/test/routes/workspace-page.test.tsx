import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderLoadedApp } from '../support/render-app';
import {
  identityHandlers,
  workspace,
} from '../features/connections/page/fixture';

const endpoint = `http://pertexo.test/v1/workspaces/${workspace.id}/connections`;

describe('workspace page setup', () => {
  it('names an authorized page consistently in its title and breadcrumb', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(endpoint, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    await renderLoadedApp(`/w/${workspace.id}/connections`);
    expect(
      await screen.findByRole('heading', { name: 'Connections' }),
    ).toBeVisible();
    await waitFor(() => {
      expect(document.title).toBe(`Connections · ${workspace.name} — Pertexo`);
    });
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText(
        'Connections',
      ),
    ).toBeVisible();
  });

  it('does not warm a resource the workspace capability snapshot denies', async () => {
    let reads = 0;
    mockServer.use(
      ...identityHandlers({ ...workspace, capabilities: ['workspace:read'] }),
      http.get(endpoint, () => {
        reads += 1;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    await renderLoadedApp(`/w/${workspace.id}/connections`);
    expect(
      await screen.findByText('Connections are unavailable'),
    ).toBeVisible();
    expect(reads).toBe(0);
  });
});
