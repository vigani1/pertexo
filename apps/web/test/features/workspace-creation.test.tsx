import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const existingWorkspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const createdWorkspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const timestamp = '2026-09-21T10:00:00.000Z';
const csrfToken = 'csrf-token-for-component-tests-12345678901234567890';
const user = {
  id: userId,
  email: 'owner@example.test',
  displayName: 'Workspace Owner',
  status: 'active',
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const existingWorkspace = accessibleWorkspace(
  existingWorkspaceId,
  'Existing Operations',
  'existing-operations',
);
const createdWorkspace = accessibleWorkspace(
  createdWorkspaceId,
  'Signal Operations',
  'signal-operations',
);

function accessibleWorkspace(id: string, name: string, slug: string) {
  return {
    id,
    name,
    slug,
    status: 'active',
    revision: 1,
    role: 'owner',
    capabilities: [
      'workspace:read',
      'workspace:manage',
      'workflow:read',
      'workflow:create',
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function workspaceResponse() {
  return {
    id: createdWorkspace.id,
    name: createdWorkspace.name,
    slug: createdWorkspace.slug,
    status: createdWorkspace.status,
    createdAt: createdWorkspace.createdAt,
    updatedAt: createdWorkspace.updatedAt,
  };
}

function problem(status: number, code: string, title: string) {
  return HttpResponse.json(
    {
      type: `https://pertexo.test/problems/${code}`,
      title,
      status,
      code,
      requestId: 'workspace-create-test',
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function installWorkspaceDestination() {
  mockServer.use(
    http.get(
      `http://pertexo.test/v1/workspaces/${createdWorkspaceId}/workflows`,
      () => HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('http://pertexo.test/v1/node-definitions', () =>
      HttpResponse.json({
        schemaVersion: 1,
        release: {
          epoch: 1,
          fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
        },
        items: [],
      }),
    ),
    http.get('http://pertexo.test/v1/integrations', () =>
      HttpResponse.json({
        schemaVersion: 1,
        release: {
          epoch: 1,
          fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
        },
        items: [],
      }),
    ),
    http.get(
      `http://pertexo.test/v1/workspaces/${createdWorkspaceId}/connections`,
      () => HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
}

function installIdentity(workspaces: readonly object[] = []) {
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: workspaces, nextCursor: null }),
    ),
  );
}

/** The inline first-workspace form, or the sheet for another workspace. */
async function openCreation(kind: 'first' | 'another') {
  if (kind === 'first')
    return screen.findByRole('region', { name: 'Create your workspace' });
  await userEvent
    .setup()
    .click(await screen.findByRole('button', { name: 'New workspace' }));
  return screen.findByRole('dialog', { name: 'New workspace' });
}

async function revealHandle(form: HTMLElement) {
  await userEvent
    .setup()
    .click(within(form).getByRole('button', { name: 'Edit handle' }));
  return within(form).getByLabelText('Handle');
}

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
    const app = renderApp('/workspaces', { strict: true });

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
    renderApp('/workspaces');

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
    renderApp('/workspaces');
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
    renderApp('/workspaces');
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
    [
      'duplicate slug',
      409,
      'workspace.conflict',
      'That handle is already taken. Choose another one.',
      'Handle',
    ],
    [
      'forbidden creation',
      403,
      'auth.forbidden',
      'Your account isn’t allowed to create workspaces.',
      undefined,
    ],
  ])(
    'shows a precise %s error without an automatic retry',
    async (_case, status, code, message, focusedField) => {
      let postCount = 0;
      installIdentity();
      mockServer.use(
        http.post('http://pertexo.test/v1/workspaces', () => {
          postCount += 1;
          return problem(status, code, 'Workspace rejected');
        }),
      );
      renderApp('/workspaces');
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

  it('preserves the exact uncertain command through failed verification and retry', async () => {
    let userReads = 0;
    let postCount = 0;
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
        HttpResponse.json({ items: authoritativeWorkspaces, nextCursor: null }),
      ),
      http.post('http://pertexo.test/v1/workspaces', async ({ request }) => {
        postCount += 1;
        attempts.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        if (postCount === 1) return HttpResponse.error();
        authoritativeWorkspaces = [createdWorkspace];
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
      await within(dialog).findByRole('button', {
        name: 'Check again',
      }),
    ).toBeVisible();

    await userEvent
      .setup()
      .click(within(dialog).getByRole('button', { name: 'Check again' }));
    expect(
      await within(dialog).findByText(
        /couldn’t confirm you’re still signed in/u,
      ),
    ).toBeVisible();
    expect(postCount).toBe(1);
    await userEvent
      .setup()
      .click(within(dialog).getByRole('button', { name: 'Check again' }));
    expect(
      await screen.findAllByRole('link', { name: 'Home', current: 'page' }),
    ).not.toHaveLength(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
  });

  it('keeps an uncertain request locked until it is checked or started over', async () => {
    let postCount = 0;
    installIdentity();
    mockServer.use(
      http.post('http://pertexo.test/v1/workspaces', () => {
        postCount += 1;
        return HttpResponse.error();
      }),
    );
    renderApp('/workspaces');
    const form = await openCreation('first');
    await userEvent
      .setup()
      .type(within(form).getByLabelText('Workspace name'), 'Uncertain');
    await userEvent
      .setup()
      .click(within(form).getByRole('button', { name: 'Create workspace' }));

    expect(
      await within(form).findByText(/not sure the workspace was created/u),
    ).toBeVisible();
    expect(within(form).getByLabelText('Workspace name')).toBeDisabled();
    expect(
      within(form).getByRole('button', { name: 'Check again' }),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(within(form).getByRole('button', { name: 'Start over' }));

    const name = within(form).getByLabelText('Workspace name');
    expect(name).toBeEnabled();
    expect(name).toHaveValue('');
    expect(postCount).toBe(1);
  });

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
