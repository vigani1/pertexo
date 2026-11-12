import { homeRoute } from '@/routes/workspace/home/route';
import { act, screen, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { renderLoadedApp } from '../../../support/render-app';

import {
  createdWorkspace,
  existingWorkspace,
  installWorkspaceDestination,
  openCreation,
  problem,
  user,
  userId,
  workspaceResponse,
} from './fixture';

describe('workspace creation', () => {
  it('reloads app identity after a session change without repeating an unconfirmed creation', async () => {
    const nextUser = {
      ...user,
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      email: 'next-owner@example.test',
      displayName: 'Next Owner',
    };
    let activeUser = user;
    let postCount = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(activeUser),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({
          items: activeUser.id === userId ? [existingWorkspace] : [],
          nextCursor: null,
        }),
      ),
      http.post('http://pertexo.test/v1/workspaces', () => {
        postCount += 1;
        activeUser = nextUser;
        return HttpResponse.error();
      }),
    );
    const app = await renderLoadedApp('/workspaces');
    const dialog = await openCreation('another');
    await userEvent
      .setup()
      .type(within(dialog).getByLabelText('Workspace name'), 'Old Session');
    await userEvent
      .setup()
      .click(within(dialog).getByRole('button', { name: 'Create workspace' }));
    await within(dialog).findByText(/couldn’t confirm/u);
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'pertexo:auth-session-change',
          newValue: JSON.stringify({
            event: 'changed',
            generation: crypto.randomUUID(),
            sender: 'other-tab',
          }),
        }),
      );
    });

    expect(await screen.findByText('next-owner@example.test')).toBeVisible();
    expect(screen.queryByText('Existing Operations')).not.toBeInTheDocument();
    expect(postCount).toBe(1);
    expect(
      app.queryClient.getQueryCache().findAll({
        queryKey: ['identity', userId],
      }),
    ).toHaveLength(0);
  });
  it('recovers a failed discovery refresh without submitting creation again', async () => {
    let created = false;
    let refreshUnavailable = true;
    let postCount = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () => {
        if (!created) return HttpResponse.json({ items: [], nextCursor: null });
        if (refreshUnavailable) {
          refreshUnavailable = false;
          return problem(503, 'service.unavailable', 'Discovery unavailable');
        }
        return HttpResponse.json({
          items: [createdWorkspace],
          nextCursor: null,
        });
      }),
      http.post('http://pertexo.test/v1/workspaces', () => {
        postCount += 1;
        created = true;
        return HttpResponse.json(workspaceResponse(), { status: 201 });
      }),
    );
    installWorkspaceDestination();
    const app = await renderLoadedApp('/workspaces');
    const dialog = await openCreation('first');
    await userEvent
      .setup()
      .type(
        within(dialog).getByLabelText('Workspace name'),
        'Signal Operations',
      );
    await userEvent
      .setup()
      .click(within(dialog).getByRole('button', { name: 'Create workspace' }));

    expect(
      await within(dialog).findByText(/workspace was created/u),
    ).toBeVisible();
    expect(postCount).toBe(1);
    const navigated = new Promise<void>((resolve) => {
      const unsubscribe = app.router.subscribe('onResolved', () => {
        if (
          !app.router.state.matches.some(
            (match) => match.routeId === homeRoute.id,
          )
        )
          return;
        unsubscribe();
        resolve();
      });
    });
    await userEvent.setup().click(
      within(dialog).getByRole('button', {
        name: 'Open workspace',
      }),
    );
    await navigated;
    expect(
      await screen.findAllByRole('link', { name: 'Home', current: 'page' }),
    ).not.toHaveLength(0);
    expect(postCount).toBe(1);
  });
});
