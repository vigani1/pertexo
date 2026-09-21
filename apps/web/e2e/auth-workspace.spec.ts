import { test, expect, type Page } from '@playwright/test';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const csrfToken = 'csrf-token-for-browser-tests-123456789012345678901234';
const user = {
  id: userId,
  email: 'operator@example.test',
  displayName: 'Pertexo Operator',
  status: 'active',
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};
const workspace = {
  id: workspaceId,
  name: 'Control Operations',
  slug: 'control-operations',
  status: 'active',
  revision: 1,
  role: 'owner',
  capabilities: [
    'workspace:read',
    'workspace:manage',
    'workflow:read',
    'workflow:create',
    'connection:read',
  ],
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};

function unauthenticatedProblem() {
  return JSON.stringify({
    type: 'https://pertexo.test/problems/auth.unauthenticated',
    title: 'Authentication required',
    status: 401,
    code: 'auth.unauthenticated',
    requestId: 'browser-request-1234',
  });
}

async function mockIdentity(
  page: Page,
  options: Readonly<{
    authenticated: boolean;
    user?: unknown;
    workspaces?: unknown[];
  }>,
) {
  let authenticated = options.authenticated;
  const currentUser = options.user ?? user;
  const workspaces = options.workspaces ?? [workspace];
  const workflows: unknown[] = [];

  await page.route('**/v1/users/me', async (route) => {
    if (authenticated) {
      await route.fulfill({ json: currentUser });
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: unauthenticatedProblem(),
    });
  });
  await page.route('**/v1/workspaces?**', async (route) => {
    await route.fulfill({ json: { items: workspaces, nextCursor: null } });
  });
  await page.route('**/v1/auth/oidc/start', async (route) => {
    await route.fulfill({
      headers: {
        'content-type': 'application/json',
        'set-cookie':
          'pertexo_oidc_binding=browser-binding; Path=/v1/auth/oidc/callback; HttpOnly; SameSite=Lax',
      },
      body: JSON.stringify({
        authorizationUrl: 'http://127.0.0.1:4173/test-oidc-provider',
        expiresAt: '2026-09-14T10:05:00.000Z',
      }),
    });
  });
  await page.route('**/test-oidc-provider', async (route) => {
    authenticated = true;
    await route.fulfill({
      status: 303,
      headers: {
        location: '/workspaces',
        'set-cookie': `pertexo_csrf=${csrfToken}; Path=/; SameSite=Lax`,
      },
    });
  });
  await page.route('**/v1/auth/logout', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-csrf-token']).toBe(csrfToken);
    authenticated = false;
    await route.fulfill({ status: 204 });
  });
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows?**`,
    async (route) => {
      await route.fulfill({ json: { items: workflows, nextCursor: null } });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows`,
    async (route) => {
      const request = route.request();
      expect(request.method()).toBe('POST');
      expect(request.headers()['x-csrf-token']).toBe(csrfToken);
      expect(request.headers()['idempotency-key']).toBeTruthy();
      const body = request.postDataJSON() as { name: string };
      const workflow = {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        workspaceId,
        name: body.name,
        lifecycleStatus: 'active',
        lifecycleRevision: 1,
        activationStatus: 'inactive',
        publishedVersionId: null,
        createdAt: '2026-09-14T10:00:00.000Z',
        updatedAt: '2026-09-14T10:00:00.000Z',
      };
      workflows.push(workflow);
      await route.fulfill({
        status: 201,
        headers: {
          'content-type': 'application/json',
          etag: `"draft-v1.${'a'.repeat(43)}"`,
        },
        body: JSON.stringify({
          workflow,
          draft: {
            workflowId: workflow.id,
            revision: 1,
            schemaVersion: 1,
            graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
            compatibility: {
              compatible: true,
              fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
              issues: [],
            },
            updatedAt: workflow.updatedAt,
          },
        }),
      });
    },
  );
  const release = {
    epoch: 1,
    fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
  };
  await page.route('**/v1/node-definitions', async (route) => {
    await route.fulfill({ json: { schemaVersion: 1, release, items: [] } });
  });
  await page.route('**/v1/integrations', async (route) => {
    await route.fulfill({ json: { schemaVersion: 1, release, items: [] } });
  });
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections?**`,
    async (route) => {
      await route.fulfill({ json: { items: [], nextCursor: null } });
    },
  );
}

test('signs in, selects a workspace, and signs out without runtime errors', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockIdentity(page, { authenticated: false });

  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Sign in to continue' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Continue with SSO' }).click();
  await expect(page).toHaveURL(/\/workspaces$/u);
  await page.getByRole('button', { name: /Control Operations/ }).click();
  await expect(page).toHaveURL(`/w/${workspaceId}/workflows`);
  await expect(
    page.getByRole('heading', { name: 'Workflows', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/u);
  await expect(
    page.getByRole('heading', { name: 'Sign in to continue' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('keeps similar workspace names distinguishable at 320 pixels', async ({
  page,
}) => {
  const workspaces = [
    {
      ...workspace,
      name: 'Control Operations Europe North',
      slug: 'control-operations-europe-north-with-a-long-slug',
    },
    {
      ...workspace,
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'Control Operations Europe South',
      slug: 'control-operations-europe-south-with-a-long-slug',
    },
  ];
  await page.setViewportSize({ width: 320, height: 640 });
  await mockIdentity(page, { authenticated: true, workspaces });
  await page.goto('/workspaces');

  for (const item of workspaces) {
    const name = page.getByText(item.name, { exact: true });
    await expect(name).toBeVisible();
    const card = page.getByRole('button', { name: new RegExp(item.name, 'u') });
    const [nameBox, cardBox] = await Promise.all([
      name.boundingBox(),
      card.boundingBox(),
    ]);
    expect(nameBox?.x).toBeGreaterThanOrEqual(cardBox?.x ?? 0);
    expect((nameBox?.x ?? 0) + (nameBox?.width ?? 0)).toBeLessThanOrEqual(
      (cardBox?.x ?? 0) + (cardBox?.width ?? 0) + 1,
    );
  }
});

test('restores an authorized workspace deep link', async ({ page }) => {
  await mockIdentity(page, { authenticated: true });
  await page.goto(`/w/${workspaceId}/workflows`);
  await expect(
    page.getByRole('heading', { name: 'Workflows', exact: true }),
  ).toBeVisible();
  const navigation = page.getByRole('navigation', {
    name: 'Workspace navigation',
  });
  await expect(
    navigation.getByRole('link', { name: 'Workflows' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText(user.email)).toBeVisible();
  await expect(
    navigation.getByRole('link', { name: 'Connections' }),
  ).toBeVisible();
  await expect(page).toHaveURL(`/w/${workspaceId}/workflows`);
});

test('keeps the mobile workspace drawer bounded and keyboard accessible', async ({
  page,
}) => {
  const longUser = {
    ...user,
    displayName:
      'Pertexo Operations Administrator With An Exceptionally Long Display Name',
    email: 'operations-administrator-with-a-long-address@example.test',
  };
  const longWorkspace = {
    ...workspace,
    name: 'Control Operations Workspace With A Deliberately Long Name',
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockIdentity(page, {
    authenticated: true,
    user: longUser,
    workspaces: [longWorkspace],
  });
  await page.goto(`/w/${workspaceId}/workflows`);

  const trigger = page.getByRole('button', { name: 'Open navigation' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Workspace navigation' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('link', { name: 'Workflows' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    drawer.getByRole('button', { name: 'Close navigation' }),
  ).toBeFocused();
  expect(
    await drawer.evaluate(
      (element) => getComputedStyle(element).transitionProperty,
    ),
  ).toBe('none');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.press('Enter');
  await drawer.getByRole('button', { name: 'Change workspace' }).click();
  await expect(page).toHaveURL(/\/workspaces$/u);
  await expect(drawer).toBeHidden();
});

test('creates a workflow from the empty index with the shared transport', async ({
  page,
}) => {
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
  await mockIdentity(page, { authenticated: true });
  await page.goto(`/w/${workspaceId}/workflows`);
  await page.getByRole('button', { name: 'Create workflow' }).click();
  await page.getByLabel('Workflow name').fill('Browser verified');
  await page.getByRole('button', { name: 'Create workflow' }).click();
  await expect(page.getByText('Browser verified')).toBeVisible();
});

test('creates the first workspace from the keyboard-accessible empty state', async ({
  page,
}) => {
  const createdId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const createdWorkspace = {
    ...workspace,
    id: createdId,
    name: 'Signal Operations',
    slug: 'signal-operations',
  };
  let accessibleWorkspaces: unknown[] = [];
  let creationRequest:
    | Readonly<{ body: unknown; csrf?: string; idempotencyKey?: string }>
    | undefined;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
  await mockIdentity(page, { authenticated: true, workspaces: [] });
  await page.route('**/v1/workspaces?**', async (route) => {
    await route.fulfill({
      json: { items: accessibleWorkspaces, nextCursor: null },
    });
  });
  await page.route('**/v1/workspaces', async (route) => {
    const request = route.request();
    creationRequest = {
      body: request.postDataJSON(),
      ...(request.headers()['x-csrf-token'] === undefined
        ? {}
        : { csrf: request.headers()['x-csrf-token'] }),
      ...(request.headers()['idempotency-key'] === undefined
        ? {}
        : { idempotencyKey: request.headers()['idempotency-key'] }),
    };
    accessibleWorkspaces = [createdWorkspace];
    await route.fulfill({
      status: 201,
      json: {
        id: createdId,
        name: createdWorkspace.name,
        slug: createdWorkspace.slug,
        status: 'active',
        createdAt: createdWorkspace.createdAt,
        updatedAt: createdWorkspace.updatedAt,
      },
    });
  });
  await page.route(
    `**/v1/workspaces/${createdId}/workflows?**`,
    async (route) => {
      await route.fulfill({ json: { items: [], nextCursor: null } });
    },
  );
  await page.route(
    `**/v1/workspaces/${createdId}/connections?**`,
    async (route) => {
      await route.fulfill({ json: { items: [], nextCursor: null } });
    },
  );

  await page.goto('/workspaces');
  const trigger = page.getByRole('button', {
    name: 'Create your first workspace',
  });
  await trigger.focus();
  await trigger.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Create a workspace' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Workspace name')).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.press('Enter');
  await dialog.getByLabel('Workspace name').fill('Signal Operations');
  await expect(dialog.getByLabel('Workspace slug')).toHaveValue(
    'signal-operations',
  );
  await dialog.getByRole('button', { name: 'Create workspace' }).click();

  await expect(page).toHaveURL(`/w/${createdId}/workflows`);
  await expect(
    page.getByRole('heading', { name: 'Workflows', exact: true }),
  ).toBeVisible();
  expect(creationRequest).toEqual({
    body: { name: 'Signal Operations', slug: 'signal-operations' },
    csrf: csrfToken,
    idempotencyKey: expect.any(String),
  });
});

test('keeps an inaccessible workspace URL visible and offers recovery', async ({
  page,
}) => {
  await mockIdentity(page, { authenticated: true });
  const unavailableId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await page.goto(`/w/${unavailableId}/workflows`);
  await expect(
    page.getByRole('heading', { name: 'This workspace is not available' }),
  ).toBeVisible();
  await expect(page).toHaveURL(`/w/${unavailableId}/workflows`);
  await page.getByRole('link', { name: 'Choose a workspace' }).click();
  await expect(page).toHaveURL(/\/workspaces$/u);
});

test('login remains keyboard-visible, motion-safe, and narrow-screen bounded', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockIdentity(page, { authenticated: false });
  await page.goto('/login');
  await expect(
    page.getByRole('heading', { name: 'Sign in to continue' }),
  ).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: 'Skip to content' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Continue with SSO' }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
