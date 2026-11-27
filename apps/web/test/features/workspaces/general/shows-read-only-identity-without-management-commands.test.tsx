import { screen, within } from '@testing-library/react';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { renderLoadedApp } from '../../../support/render-app';

import {
  identityHandlers,
  lifecycleChange,
  workspace,
  workspaceId,
} from './fixture';

describe('workspace settings', () => {
  it('shows read-only identity without management commands when capability is absent', async () => {
    let requests = 0;
    mockServer.use(
      ...identityHandlers({ ...workspace, capabilities: ['workspace:read'] }),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/deletion`,
        () => {
          requests += 1;
          return HttpResponse.json(lifecycleChange());
        },
      ),
    );
    await renderLoadedApp(`/w/${workspaceId}/settings`);
    expect(
      await screen.findByRole('heading', { name: 'How it’s known' }),
    ).toBeVisible();
    expect(screen.getAllByText('Control Operations').length).toBeGreaterThan(0);
    expect(screen.getByText('control-operations')).toBeVisible();
    const access = within(screen.getByRole('region', { name: 'Your access' }));
    expect(
      access.getByRole('heading', { name: 'You’re an Owner' }),
    ).toBeVisible();
    expect(access.getByText(/^Everything, including renaming/u)).toBeVisible();
    expect(
      access.getByText('Someone who manages members can change your role.'),
    ).toBeVisible();
    expect(
      access.queryByRole('link', { name: 'Compare roles on Team' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Copy workspace ID / }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Rename workspace' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete workspace' }),
    ).not.toBeInTheDocument();
    expect(requests).toBe(0);
  });
});
