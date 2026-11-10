import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import {
  authenticatedHandlers,
  workspace,
  workspaceId,
} from './workspace-entry/fixture';

describe('workspace deletion visibility', () => {
  it('shows purging without workspace actions and confirms disappearance only after observing purging', async () => {
    let gone = false;
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({
          items: gone ? [] : [{ ...workspace, status: 'purging' }],
          nextCursor: null,
        }),
      ),
      ...authenticatedHandlers(),
    );
    await renderLoadedApp(`/w/${workspaceId}`);
    expect(
      await screen.findByRole('heading', {
        name: 'This workspace is being deleted',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Restore' }),
    ).not.toBeInTheDocument();
    gone = true;
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Refresh deletion status' }));
    expect(
      await screen.findByText(
        'Deletion finished. This workspace and its data are gone.',
      ),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Choose a workspace' }),
    ).toHaveAttribute('href', '/workspaces');
  });
  it('enters the deletion view when a mounted workspace refreshes to purging', async () => {
    let purging = false;
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({
          items: [{ ...workspace, status: purging ? 'purging' : 'active' }],
          nextCursor: null,
        }),
      ),
      ...authenticatedHandlers(),
    );
    const app = await renderLoadedApp(`/w/${workspaceId}/settings`);
    await screen.findByRole('heading', { name: 'Settings' });
    purging = true;
    await app.queryClient.invalidateQueries({ queryKey: ['identity'] });
    expect(
      await screen.findByRole('heading', {
        name: 'This workspace is being deleted',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Delete workspace' }),
    ).not.toBeInTheDocument();
  });
  it('keeps a fresh visit after deletion non-disclosing', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      ...authenticatedHandlers(),
    );
    await renderLoadedApp(`/w/${workspaceId}`);
    expect(await screen.findByText(/The link is wrong/u)).toBeVisible();
    expect(screen.queryByText(/Deletion finished/u)).not.toBeInTheDocument();
  });
  it('does not infer deletion completion from a failed refresh and recovers through another status read', async () => {
    let outcome: 'purging' | 'unavailable' | 'gone' = 'purging';
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        outcome === 'unavailable'
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json({
              items:
                outcome === 'gone' ? [] : [{ ...workspace, status: 'purging' }],
              nextCursor: null,
            }),
      ),
      ...authenticatedHandlers(),
    );
    await renderLoadedApp(`/w/${workspaceId}`);
    const user = userEvent.setup();
    await screen.findByRole('heading', {
      name: 'This workspace is being deleted',
    });
    outcome = 'unavailable';
    await user.click(
      screen.getByRole('button', { name: 'Refresh deletion status' }),
    );
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(
      screen.getByRole('heading', { name: 'This workspace is being deleted' }),
    ).toBeVisible();
    expect(
      screen.queryByText(
        'Deletion finished. This workspace and its data are gone.',
      ),
    ).not.toBeInTheDocument();
    outcome = 'gone';
    await user.click(retry);
    expect(
      await screen.findByText(
        'Deletion finished. This workspace and its data are gone.',
      ),
    ).toBeVisible();
  });
});
