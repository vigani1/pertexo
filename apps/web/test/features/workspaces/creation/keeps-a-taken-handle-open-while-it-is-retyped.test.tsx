import { waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../../../support/mock-server';
import { renderLoadedApp } from '../../../support/render-app';
import {
  createdWorkspace,
  installIdentity,
  installWorkspaceDestination,
  openCreation,
  problem,
  workspaceResponse,
} from './fixture';

describe('workspace creation after a taken handle', () => {
  it('keeps a taken handle open while it is retyped and sends the new one', async () => {
    const slugs: unknown[] = [];
    let authoritativeWorkspaces: object[] = [];
    installIdentity();
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: authoritativeWorkspaces, nextCursor: null }),
      ),
      http.post('http://pertexo.test/v1/workspaces', async ({ request }) => {
        const { slug } = (await request.json()) as { slug: string };
        slugs.push(slug);
        if (slugs.length === 1)
          return problem(409, 'workspace.conflict', 'Handle in use');
        authoritativeWorkspaces = [createdWorkspace];
        return HttpResponse.json(workspaceResponse(), { status: 201 });
      }),
    );
    installWorkspaceDestination();
    await renderLoadedApp('/workspaces');
    const form = await openCreation('first');
    const event = userEvent.setup();
    await event.type(
      within(form).getByLabelText('Workspace name'),
      'Signal Operations',
    );
    await event.click(
      within(form).getByRole('button', { name: 'Create workspace' }),
    );
    const handle = await within(form).findByRole('textbox', { name: 'Handle' });
    expect(handle).toHaveAccessibleDescription(
      /That handle is already taken\. Choose another one\./u,
    );
    await event.type(handle, '-team');
    expect(within(form).getByRole('textbox', { name: 'Handle' })).toHaveValue(
      'signal-operations-team',
    );
    await event.click(
      within(form).getByRole('button', { name: 'Create workspace' }),
    );
    await waitFor(() => {
      expect(slugs).toEqual(['signal-operations', 'signal-operations-team']);
    });
  });
});
