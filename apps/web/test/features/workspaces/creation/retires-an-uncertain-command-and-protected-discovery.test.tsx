import { screen, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

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
  it('retires an uncertain command and protected discovery when the session identity changes', async () => {
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
    const app = renderApp('/workspaces');
    const dialog = await openCreation('another');
    await userEvent
      .setup()
      .type(within(dialog).getByLabelText('Workspace name'), 'Old Session');
    await userEvent
      .setup()
      .click(within(dialog).getByRole('button', { name: 'Create workspace' }));
    await userEvent.setup().click(
      await within(dialog).findByRole('button', {
        name: 'Check again',
      }),
    );

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
    let workspaceReads = 0;
    let postCount = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () => {
        workspaceReads += 1;
        if (workspaceReads === 1)
          return HttpResponse.json({ items: [], nextCursor: null });
        if (workspaceReads === 2)
          return problem(503, 'service.unavailable', 'Discovery unavailable');
        return HttpResponse.json({
          items: [createdWorkspace],
          nextCursor: null,
        });
      }),
      http.post('http://pertexo.test/v1/workspaces', () => {
        postCount += 1;
        return HttpResponse.json(workspaceResponse(), { status: 201 });
      }),
    );
    installWorkspaceDestination();
    renderApp('/workspaces');
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
    await userEvent.setup().click(
      within(dialog).getByRole('button', {
        name: 'Open workspace',
      }),
    );
    expect(
      await screen.findAllByRole('link', { name: 'Home', current: 'page' }),
    ).not.toHaveLength(0);
    expect(postCount).toBe(1);
  });
});
