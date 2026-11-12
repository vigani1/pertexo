import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../support/mock-server';

import { renderLoadedApp } from '../../support/render-app';

import {
  createdWorkspace,
  createdWorkspaceId,
  csrfToken,
  existingWorkspace,
  installIdentity,
  installWorkspaceDestination,
  openCreation,
  problem,
  revealHandle,
  user,
  workspaceResponse,
} from './creation/fixture';

describe('workspace creation', () => {
  it('creates the first workspace with CSRF/idempotency and enters its empty workflow list', async () => {
    let authoritativeWorkspaces: object[] = [];
    const requests: { body: unknown; csrf?: string; key?: string }[] = [];
    installIdentity(authoritativeWorkspaces);
    installWorkspaceDestination();
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({
          items: authoritativeWorkspaces,
          nextCursor: null,
        }),
      ),
      http.post('http://pertexo.test/v1/workspaces', async ({ request }) => {
        const csrf = request.headers.get('x-csrf-token');
        const key = request.headers.get('idempotency-key');
        requests.push({
          body: await request.json(),
          ...(csrf === null ? {} : { csrf }),
          ...(key === null ? {} : { key }),
        });
        authoritativeWorkspaces = [createdWorkspace];
        return HttpResponse.json(workspaceResponse(), { status: 201 });
      }),
    );
    const app = await renderLoadedApp('/workspaces', { strict: true });

    const dialog = await openCreation('first');
    const name = within(dialog).getByLabelText('Workspace name');
    await userEvent.setup().type(name, 'Signal Operations');
    expect(within(dialog).getByText('signal-operations')).toBeVisible();
    await userEvent
      .setup()
      .click(within(dialog).getByRole('button', { name: 'Create workspace' }));

    expect(
      await screen.findAllByRole('link', { name: 'Home', current: 'page' }),
    ).not.toHaveLength(0);
    expect(app.router.state.location.pathname).toBe(`/w/${createdWorkspaceId}`);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toEqual({
      name: 'Signal Operations',
      slug: 'signal-operations',
    });
    expect(requests[0]?.csrf).toBe(csrfToken);
    expect(typeof requests[0]?.key).toBe('string');
  });
  it('uses the same form for an additional workspace and preserves an edited slug', async () => {
    let authoritativeWorkspaces: object[] = [existingWorkspace];
    installIdentity(authoritativeWorkspaces);
    installWorkspaceDestination();
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: authoritativeWorkspaces, nextCursor: null }),
      ),
      http.post('http://pertexo.test/v1/workspaces', async ({ request }) => {
        expect(await request.json()).toEqual({
          name: 'Renamed Team',
          slug: 'chosen-slug',
        });
        authoritativeWorkspaces = [existingWorkspace, createdWorkspace];
        return HttpResponse.json(workspaceResponse(), { status: 201 });
      }),
    );
    await renderLoadedApp('/workspaces');

    const dialog = await openCreation('another');
    const name = within(dialog).getByLabelText('Workspace name');
    await userEvent.setup().type(name, 'Initial Team');
    const slug = await revealHandle(dialog);
    expect(slug).toHaveFocus();
    expect(slug).toHaveValue('initial-team');
    await userEvent.setup().clear(slug);
    await userEvent.setup().type(slug, 'chosen-slug');
    await userEvent.setup().clear(name);
    await userEvent.setup().type(name, 'Renamed Team');
    expect(slug).toHaveValue('chosen-slug');
    await userEvent
      .setup()
      .click(within(dialog).getByRole('button', { name: 'Create workspace' }));
    expect(
      await screen.findAllByRole('link', { name: 'Home', current: 'page' }),
    ).not.toHaveLength(0);
  });
  it('validates on submit and focuses the first invalid field', async () => {
    installIdentity();
    await renderLoadedApp('/workspaces');
    const form = await openCreation('first');
    const name = within(form).getByLabelText('Workspace name');

    await userEvent.setup().click(name);
    await userEvent.setup().tab();
    expect(
      within(form).queryByText(/Give the workspace a name/u),
    ).not.toBeInTheDocument();
    expect(name).toHaveAttribute('aria-invalid', 'false');
    const slug = await revealHandle(form);
    await userEvent.setup().type(slug, 'Not valid');
    await userEvent
      .setup()
      .click(within(form).getByRole('button', { name: 'Create workspace' }));
    expect(name).toHaveFocus();
    expect(within(form).getByText(/Give the workspace a name/u)).toBeVisible();
    expect(slug).toHaveAttribute('aria-invalid', 'true');

    await userEvent.setup().type(name, 'Valid name');
    expect(name).toHaveAttribute('aria-invalid', 'false');
    await userEvent
      .setup()
      .click(within(form).getByRole('button', { name: 'Create workspace' }));
    expect(slug).toHaveFocus();
  });
  it('reveals an invalid handle on submit and cancels the sheet cleanly', async () => {
    installIdentity([existingWorkspace]);
    await renderLoadedApp('/workspaces');
    const sheet = await openCreation('another');
    await userEvent
      .setup()
      .type(within(sheet).getByLabelText('Workspace name'), '!!!');
    await userEvent
      .setup()
      .click(within(sheet).getByRole('button', { name: 'Create workspace' }));
    const handle = within(sheet).getByLabelText('Handle');
    expect(handle).toHaveFocus();
    expect(handle).toHaveAttribute('aria-invalid', 'true');

    await userEvent
      .setup()
      .click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'New workspace' }),
      ).not.toBeInTheDocument();
    });
    const reopened = await openCreation('another');
    expect(within(reopened).getByLabelText('Workspace name')).toHaveValue('');
    expect(within(reopened).queryByLabelText('Handle')).not.toBeInTheDocument();
  });
  it.each([
    {
      caseName: 'duplicate slug',
      status: 409,
      code: 'workspace.conflict',
      message: 'That handle is already taken. Choose another one.',
      focusedField: 'Handle',
    },
    {
      caseName: 'forbidden creation',
      status: 403,
      code: 'auth.forbidden',
      message: 'Your account isn’t allowed to create workspaces.',
      focusedField: undefined,
    },
  ])(
    'shows a precise $caseName error without an automatic retry',
    async ({ status, code, message, focusedField }) => {
      let postCount = 0;
      installIdentity();
      mockServer.use(
        http.post('http://pertexo.test/v1/workspaces', () => {
          postCount += 1;
          return problem(status, code, 'Workspace rejected');
        }),
      );
      await renderLoadedApp('/workspaces');
      const dialog = await openCreation('first');
      await userEvent
        .setup()
        .type(within(dialog).getByLabelText('Workspace name'), 'Duplicate');
      await userEvent
        .setup()
        .click(
          within(dialog).getByRole('button', { name: 'Create workspace' }),
        );

      expect(await within(dialog).findByText(message)).toBeVisible();
      expect(postCount).toBe(1);
      if (focusedField !== undefined)
        expect(within(dialog).getByLabelText(focusedField)).toHaveFocus();
    },
  );
  it.each(['network', '502', '503', '504'])(
    'replays an unchanged creation after %s with the same key and no identity preflights',
    async (failure) => {
      let userReads = 0;
      let postCount = 0;
      const identityReadsAtPost: number[] = [];
      const attempts: { body: unknown; key: string | null }[] = [];
      let authoritativeWorkspaces: object[] = [];
      mockServer.use(
        http.get('http://pertexo.test/v1/users/me', () => {
          userReads += 1;
          if (userReads === 3)
            return problem(503, 'service.unavailable', 'Identity unavailable');
          return HttpResponse.json(user);
        }),
        http.get('http://pertexo.test/v1/workspaces', () =>
          HttpResponse.json({
            items: authoritativeWorkspaces,
            nextCursor: null,
          }),
        ),
        http.post('http://pertexo.test/v1/workspaces', async ({ request }) => {
          postCount += 1;
          identityReadsAtPost.push(userReads);
          attempts.push({
            body: await request.json(),
            key: request.headers.get('idempotency-key'),
          });
          if (postCount === 1)
            return failure === 'network'
              ? HttpResponse.error()
              : problem(
                  Number(failure),
                  'internal.unexpected',
                  'Gateway unavailable',
                );
          authoritativeWorkspaces = [createdWorkspace];
          return HttpResponse.json(workspaceResponse(), { status: 201 });
        }),
      );
      installWorkspaceDestination();
      await renderLoadedApp('/workspaces');
      const dialog = await openCreation('first');
      await userEvent
        .setup()
        .type(
          within(dialog).getByLabelText('Workspace name'),
          'Signal Operations',
        );
      await userEvent
        .setup()
        .click(
          within(dialog).getByRole('button', { name: 'Create workspace' }),
        );
      await within(dialog).findByText(
        /couldn’t confirm whether the workspace was created/u,
      );
      expect(within(dialog).getByLabelText('Workspace name')).toBeEnabled();
      expect(within(dialog).getByLabelText('Workspace name')).toHaveValue(
        'Signal Operations',
      );
      await userEvent
        .setup()
        .click(
          within(dialog).getByRole('button', { name: 'Create workspace' }),
        );
      expect(
        await screen.findAllByRole('link', { name: 'Home', current: 'page' }),
      ).not.toHaveLength(0);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toEqual(attempts[0]);
      expect(attempts[0]?.key).toBeTruthy();
      expect(identityReadsAtPost).toEqual([1, 1]);
    },
  );
  it('keeps an unconfirmed creation editable without silently issuing another command', async () => {
    let postCount = 0;
    installIdentity();
    mockServer.use(
      http.post('http://pertexo.test/v1/workspaces', () => {
        postCount += 1;
        return HttpResponse.error();
      }),
    );
    await renderLoadedApp('/workspaces');
    const form = await openCreation('first');
    await userEvent
      .setup()
      .type(within(form).getByLabelText('Workspace name'), 'Uncertain');
    await userEvent
      .setup()
      .click(within(form).getByRole('button', { name: 'Create workspace' }));

    expect(
      await within(form).findByText(
        /couldn’t confirm whether the workspace was created/u,
      ),
    ).toBeVisible();
    const name = within(form).getByLabelText('Workspace name');
    expect(name).toBeEnabled();
    expect(name).toHaveValue('Uncertain');
    expect(
      within(form).queryByRole('button', { name: 'Check again' }),
    ).not.toBeInTheDocument();
    expect(
      within(form).getByRole('button', { name: 'Create workspace' }),
    ).toBeEnabled();
    expect(postCount).toBe(1);
  });
  it('opens the workspace a lost creation made instead of calling its handle taken', async () => {
    // The server committed the first request; only that key replays it, and
    // any other key finds the handle already in use.
    const keys: (string | null)[] = [];
    let authoritativeWorkspaces: object[] = [];
    installIdentity();
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: authoritativeWorkspaces, nextCursor: null }),
      ),
      http.post('http://pertexo.test/v1/workspaces', ({ request }) => {
        const key = request.headers.get('idempotency-key');
        keys.push(key);
        authoritativeWorkspaces = [createdWorkspace];
        if (keys.length === 1) return HttpResponse.error();
        return key === keys[0]
          ? HttpResponse.json(workspaceResponse(), { status: 201 })
          : problem(409, 'workspace.conflict', 'Handle in use');
      }),
    );
    installWorkspaceDestination();
    await renderLoadedApp('/workspaces');
    const dialog = await openCreation('first');
    const event = userEvent.setup();
    await event.type(
      within(dialog).getByLabelText('Workspace name'),
      'Signal Operations',
    );
    await event.click(
      within(dialog).getByRole('button', { name: 'Create workspace' }),
    );
    await within(dialog).findByText(
      /couldn’t confirm whether the workspace was created/u,
    );
    await event.click(
      within(dialog).getByRole('button', { name: 'Create workspace' }),
    );
    expect(
      await screen.findAllByRole('link', { name: 'Home', current: 'page' }),
    ).not.toHaveLength(0);
    expect(screen.queryByText(/already taken/u)).not.toBeInTheDocument();
    expect(keys).toHaveLength(2);
  });
  it('sends a new key once the details change after an unconfirmed creation', async () => {
    const attempts: { body: unknown; key: string | null }[] = [];
    installIdentity();
    mockServer.use(
      http.post('http://pertexo.test/v1/workspaces', async ({ request }) => {
        attempts.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        return HttpResponse.error();
      }),
    );
    await renderLoadedApp('/workspaces');
    const form = await openCreation('first');
    const event = userEvent.setup();
    const name = within(form).getByLabelText('Workspace name');
    await event.type(name, 'Uncertain');
    await event.click(
      within(form).getByRole('button', { name: 'Create workspace' }),
    );
    await within(form).findByText(
      /couldn’t confirm whether the workspace was created/u,
    );
    await event.type(name, ' team');
    await event.click(
      within(form).getByRole('button', { name: 'Create workspace' }),
    );
    await waitFor(() => {
      expect(attempts).toHaveLength(2);
    });
    expect(attempts[1]?.body).not.toEqual(attempts[0]?.body);
    expect(attempts[1]?.key).toBeTruthy();
    expect(attempts[1]?.key).not.toBe(attempts[0]?.key);
  });
});
