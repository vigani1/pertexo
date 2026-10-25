import { screen, within } from '@testing-library/react';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

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
    renderApp(`/w/${workspaceId}/settings`);
    expect(
      await screen.findByRole('heading', { name: 'Workspace' }),
    ).toBeVisible();
    expect(screen.getAllByText('Control Operations').length).toBeGreaterThan(0);
    expect(screen.getByText('control-operations')).toBeVisible();
    expect(screen.getByText('You’re an Owner here.')).toBeVisible();
    // Access follows what the workspace grants, not the role's name alone.
    const access = within(screen.getByRole('region', { name: 'Your access' }));
    expect(
      access.getByText('See workflows, runs and connections'),
    ).toHaveTextContent('See workflows, runs and connections');
    expect(access.getAllByText(': not with your role')).toHaveLength(11);
    expect(
      access.getByText('Read the audit log and manage audit retention'),
    ).toBeVisible();
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
