import { test, expect, type Page } from '@playwright/test';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const csrfToken = 'csrf-token-for-browser-tests-123456789012345678901234';
const user = {
  id: userId,
  email: 'operator@example.test',
  displayName: 'Pertexo Operator',
  status: 'active',
  revision: 1,
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
    workflows?: unknown[];
  }>,
) {
  let authenticated = options.authenticated;
  const currentUser = options.user ?? user;
  const workspaces = options.workspaces ?? [workspace];
  const workflows = options.workflows ?? [];

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
  await page.route('**/v1/auth/capabilities', async (route) => {
    await route.fulfill({
      json: {
        password: {
          enabled: true,
          minimumLength: 12,
          verificationRequired: true,
        },
        socialProviders: [],
      },
    });
  });
  await page.route('**/v1/auth/sign-in/email', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toMatchObject({
      email: 'operator@example.test',
      password: 'correct horse battery staple',
    });
    authenticated = true;
    await route.fulfill({
      status: 200,
      headers: {
        'set-cookie': `pertexo_csrf=${csrfToken}; Path=/; SameSite=Lax`,
      },
      json: { redirect: false, token: null, user: currentUser },
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
        nameRevision: 1,
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

test('signs in, lands in the only workspace, and signs out without runtime errors', async ({
  page,
}) => {
  const errors: string[] = [];
  const scripts: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/assets/') && request.url().endsWith('.js'))
      scripts.push(request.url());
  });
  await mockIdentity(page, { authenticated: false });

  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Sign in to continue' }),
  ).toBeVisible();
  await page.getByLabel('Email').fill('operator@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`/w/${workspaceId}`);
  expect(
    scripts.some((url) =>
      /(?:sign-up|password-reset|account-security)-page-[^/]+\.js$/u.test(url),
    ),
  ).toBe(false);
  await page.getByRole('button', { name: /^Account menu for/u }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/u);
  await expect(
    page.getByRole('heading', { name: 'Sign in to continue' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('renders configured social providers as accessible Pertexo controls', async ({
  page,
}) => {
  await mockIdentity(page, { authenticated: false });
  await page.route('**/v1/auth/capabilities', async (route) => {
    await route.fulfill({
      json: {
        password: {
          enabled: true,
          minimumLength: 12,
          verificationRequired: true,
        },
        socialProviders: ['google', 'microsoft', 'github', 'apple'],
      },
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');

  for (const provider of ['Google', 'Microsoft', 'GitHub', 'Apple']) {
    const button = page.getByRole('button', {
      name: `Continue with ${provider}`,
    });
    await expect(button).toBeVisible();
    await expect(button.locator('svg')).toBeVisible();
  }

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.setViewportSize({ width: 900, height: 900 });
  const googleBox = await page
    .getByRole('button', { name: 'Continue with Google' })
    .boundingBox();
  const microsoftBox = await page
    .getByRole('button', { name: 'Continue with Microsoft' })
    .boundingBox();
  expect(googleBox?.y).toBe(microsoftBox?.y);
});

test('shows the live edge and execution orb while sign-in is pending', async ({
  page,
}) => {
  await mockIdentity(page, { authenticated: false });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/v1/auth/sign-in/email', async (route) => {
    await gate;
    await route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: unauthenticatedProblem(),
    });
  });

  await page.goto('/login');
  await page.getByLabel('Email').fill('operator@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in' }).click();

  const pendingButton = page.getByRole('button', { name: 'Signing in…' });
  await expect(pendingButton).toBeDisabled();
  await expect(
    pendingButton.locator('[data-slot="loading-orb"]'),
  ).toBeVisible();
  await expect(page.locator('[data-slot="auth-lens"].live-edge')).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toBeVisible();

  release?.();
  await expect(page.getByRole('alert')).toBeVisible();
});

test('signing out in one tab clears protected workspace views in another tab', async ({
  page,
}) => {
  const second = await page.context().newPage();
  let authenticated = true;
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
  for (const tab of [page, second]) {
    await mockIdentity(tab, { authenticated: true });
    await tab.route('**/v1/users/me', async (route) => {
      if (authenticated) await route.fulfill({ json: user });
      else
        await route.fulfill({
          status: 401,
          contentType: 'application/problem+json',
          body: unauthenticatedProblem(),
        });
    });
  }
  await second.route('**/v1/auth/logout', async (route) => {
    expect(route.request().headers()['x-csrf-token']).toBe(csrfToken);
    authenticated = false;
    await route.fulfill({ status: 204 });
  });

  await page.goto('/workspaces');
  await second.goto('/workspaces');
  await expect(
    page.getByRole('button', { name: /Control Operations/u }),
  ).toBeVisible();
  await second.getByRole('button', { name: /^Account menu for/u }).click();
  await second.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(second).toHaveURL(/\/login$/u);
  await expect(page).toHaveURL(/\/login$/u);
  await expect(page.getByText('Control Operations')).toHaveCount(0);
  await second.close();
});

test('a confirmed account switch revalidates another open workspace tab', async ({
  page,
}) => {
  const second = await page.context().newPage();
  const anotherUser = {
    ...user,
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    email: 'second@example.test',
    displayName: 'Second Operator',
  };
  let currentUser = user;
  for (const tab of [page, second]) {
    await mockIdentity(tab, { authenticated: true });
    await tab.route('**/v1/users/me', async (route) => {
      await route.fulfill({ json: currentUser });
    });
  }
  await second.route('**/v1/auth/account-security', async (route) => {
    await route.fulfill({
      json: {
        email: user.email,
        emailVerified: true,
        availableProviders: [],
        methods: [],
      },
    });
  });
  await second.route('**/v1/auth/account-security/sessions', async (route) => {
    await route.fulfill({ json: { items: [] } });
  });

  await page.goto('/workspaces');
  await second.goto('/account/security');
  await expect(page.getByText(user.email)).toBeVisible();
  currentUser = anotherUser;
  await second.getByRole('link', { name: 'Back to Pertexo' }).click();
  await expect(page.getByText(anotherUser.email)).toBeVisible();
  await expect(page.getByText(user.email)).toHaveCount(0);
  await second.close();
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
  const navigation = page.getByRole('navigation', { name: 'Workspace' });
  await expect(
    navigation.getByRole('link', { name: 'Workflows' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('button', { name: /^Account menu for/u }),
  ).toBeVisible();
  await expect(
    navigation.getByRole('link', { name: 'Connections' }),
  ).toBeVisible();
  await expect(page).toHaveURL(`/w/${workspaceId}/workflows`);
});

test('keeps workflow metadata contained and labeled at responsive widths', async ({
  page,
}, testInfo) => {
  const longName =
    'Quarterly access review with a deliberately long operational workflow name';
  await mockIdentity(page, {
    authenticated: true,
    workflows: [
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        workspaceId,
        name: longName,
        nameRevision: 1,
        lifecycleStatus: 'active',
        lifecycleRevision: 1,
        activationStatus: 'active',
        publishedVersionId: null,
        createdAt: '2026-09-14T10:00:00.000Z',
        updatedAt: '2026-09-14T10:00:00.000Z',
      },
    ],
  });
  await page.goto(`/w/${workspaceId}/workflows`);

  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const surface = page.getByRole('region', { name: 'Workspace workflows' });
    const updated = surface.getByTitle(/Sep 14, 2026/u);
    await expect(page.getByRole('link', { name: longName })).toBeVisible();
    await expect(surface.getByText('Draft', { exact: true })).toBeVisible();
    const [surfaceBox, updatedBox] = await Promise.all([
      surface.boundingBox(),
      updated.boundingBox(),
    ]);
    expect((updatedBox?.x ?? 0) + (updatedBox?.width ?? 0)).toBeLessThanOrEqual(
      (surfaceBox?.x ?? 0) + (surfaceBox?.width ?? 0) + 1,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (width === 768 || width === 1024) {
      const screenshot = await page.screenshot({ fullPage: true });
      await testInfo.attach(`workflow-collection-${String(width)}`, {
        body: screenshot,
        contentType: 'image/png',
      });
      if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
        await page.screenshot({
          path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/workflow-collection-${String(width)}.png`,
          fullPage: true,
        });
    }
  }
});

test('keeps the mobile workspace bar and More sheet bounded and keyboard accessible', async ({
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

  const bar = page.getByRole('navigation', { name: 'Workspace' });
  await expect(bar.getByRole('link', { name: 'Workflows' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const trigger = bar.getByRole('button', { name: 'More' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'More' });
  await expect(drawer).toBeVisible();
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
  await drawer.getByRole('link', { name: 'All workspaces' }).click();
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
  const createdWorkflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  // After creating, the list opens the new workflow's Build tab.
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${createdWorkflowId}**`,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const workflow = {
        id: createdWorkflowId,
        workspaceId,
        name: 'Browser verified',
        nameRevision: 1,
        lifecycleStatus: 'active',
        lifecycleRevision: 1,
        activationStatus: 'inactive',
        publishedVersionId: null,
        createdAt: '2026-09-14T10:00:00.000Z',
        updatedAt: '2026-09-14T10:00:00.000Z',
      };
      if (path.endsWith('/draft')) {
        await route.fulfill({
          headers: {
            'content-type': 'application/json',
            etag: `"draft-v1.${'a'.repeat(43)}"`,
          },
          body: JSON.stringify({
            workflowId: createdWorkflowId,
            revision: 1,
            schemaVersion: 1,
            graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
            compatibility: {
              compatible: true,
              fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
              issues: [],
            },
            updatedAt: workflow.updatedAt,
          }),
        });
        return;
      }
      if (path.endsWith(createdWorkflowId)) {
        await route.fulfill({ json: { workflow } });
        return;
      }
      await route.fulfill({ json: { items: [], nextCursor: null } });
    },
  );
  await page.goto(`/w/${workspaceId}/workflows`);
  await page.getByRole('button', { name: 'New workflow' }).click();
  await page.getByLabel('Workflow name').fill('Browser verified');
  await page.getByRole('button', { name: 'Create workflow' }).click();
  await expect(page).toHaveURL(
    `/w/${workspaceId}/workflows/${createdWorkflowId}`,
  );
  await expect(
    page.getByRole('heading', { name: 'Browser verified' }),
  ).toBeVisible();
});

test('creates the first workspace inline from the keyboard', async ({
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
  await expect(
    page.getByRole('heading', { name: 'Create your workspace' }),
  ).toBeVisible();
  const name = page.getByLabel('Workspace name');
  await name.focus();
  await page.keyboard.type('Signal Operations');
  await expect(
    page.getByText('signal-operations', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(`/w/${createdId}`);
  await expect(
    page
      .getByRole('navigation', { name: 'Workspace' })
      .getByRole('link', { name: 'Home' }),
  ).toHaveAttribute('aria-current', 'page');
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
    page.getByRole('heading', { name: 'This workspace isn’t available' }),
  ).toBeVisible();
  await expect(page).toHaveURL(`/w/${unavailableId}/workflows`);
  await page.getByRole('link', { name: 'Choose a workspace' }).click();
  await expect(page).toHaveURL(/\/workspaces$/u);
});

test('login remains keyboard-visible, motion-safe, and narrow-screen bounded', async ({
  page,
}) => {
  const scripts: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/assets/') && request.url().endsWith('.js'))
      scripts.push(request.url());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockIdentity(page, { authenticated: false });
  await page.goto('/login');
  await expect(
    page.getByRole('heading', { name: 'Sign in to continue' }),
  ).toBeVisible();
  expect(
    scripts.some((url) =>
      /(?:sign-up|password-reset|account-security|workspace-selection|workflow-list)-(?:page|route)-[^/]+\.js$/u.test(
        url,
      ),
    ),
  ).toBe(false);
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: 'Skip to content' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Email')).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('explains expired and first-stage email verification links', async ({
  page,
}) => {
  await mockIdentity(page, { authenticated: false });
  await page.goto('/login?error=verification_invalid');
  await expect(
    page.getByText(/verification link is invalid, expired, or already used/u),
  ).toBeVisible();
  await page.goto('/login?emailChangePending=true');
  await expect(
    page.getByText(/Check your new address for the final verification link/u),
  ).toBeVisible();
});

test('sends a fresh verification link again after reload without repeating signup', async ({
  page,
}) => {
  await mockIdentity(page, { authenticated: false });
  let signupCount = 0;
  const resendAddresses: string[] = [];
  await page.route('**/v1/auth/sign-up/email', async (route) => {
    signupCount += 1;
    await route.fulfill({ json: { user: null } });
  });
  await page.route('**/v1/auth/send-verification-email', async (route) => {
    resendAddresses.push(
      (route.request().postDataJSON() as { email: string }).email,
    );
    await route.fulfill({ json: { status: true } });
  });
  const requestNewLink = async () => {
    await page.goto('/login?error=verification_invalid');
    await page.getByRole('button', { name: 'Send a new link' }).click();
    await page.getByLabel('Email').fill('operator@example.test');
    await page.getByRole('button', { name: 'Send link' }).click();
  };
  await requestNewLink();
  await expect(
    page.getByRole('heading', { name: 'Verify your email' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Resend in/u })).toBeDisabled();
  await page.reload();
  await requestNewLink();
  await expect.poll(() => resendAddresses.length).toBe(2);
  expect(resendAddresses).toEqual([
    'operator@example.test',
    'operator@example.test',
  ]);
  expect(signupCount).toBe(0);
});

test('recovers password recovery after a capabilities outage without exposing account existence', async ({
  page,
}) => {
  await mockIdentity(page, { authenticated: false });
  let available = false;
  await page.route('**/v1/auth/capabilities', async (route) => {
    if (!available) {
      await route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://pertexo.test/problems/provider.unavailable',
          title: 'Authentication unavailable',
          status: 503,
          code: 'provider.unavailable',
          requestId: 'capabilities-outage',
        }),
      });
      return;
    }
    await route.fulfill({
      json: {
        password: {
          enabled: true,
          minimumLength: 12,
          verificationRequired: true,
        },
        socialProviders: [],
      },
    });
  });
  let resetRequests = 0;
  await page.route('**/v1/auth/request-password-reset', async (route) => {
    resetRequests += 1;
    expect(route.request().postDataJSON()).toMatchObject({
      email: 'unknown@example.test',
    });
    await route.fulfill({ json: { status: true } });
  });
  await page.goto('/forgot-password');
  await expect(
    page.getByText('Password recovery is not available right now.'),
  ).toBeVisible();
  expect(resetRequests).toBe(0);
  available = true;
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByLabel('Email').fill('unknown@example.test');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(/If an account exists for/u)).toBeVisible();
  expect(resetRequests).toBe(1);
});

test('distinguishes an invalid reset link from a lost completion response', async ({
  page,
}) => {
  await mockIdentity(page, { authenticated: false });
  let loseResponse = false;
  await page.route(
    '**/v1/auth/account-security/password/reset',
    async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        token: 'one-time-token',
      });
      if (loseResponse) {
        await route.abort('failed');
        return;
      }
      await route.fulfill({
        status: 400,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://pertexo.test/problems/auth.reset_link_invalid',
          title: 'Reset link invalid or expired',
          status: 400,
          code: 'auth.reset_link_invalid',
          requestId: 'invalid-reset',
        }),
      });
    },
  );
  await page.goto('/reset-password?token=one-time-token');
  await page
    .getByLabel('New password', { exact: true })
    .fill('a new secure password value');
  await page
    .getByLabel('Confirm new password', { exact: true })
    .fill('a new secure password value');
  await page.getByRole('button', { name: 'Reset password' }).click();
  // A refused link can't be fixed from the form, so the page says so and
  // offers the way on instead.
  await expect(
    page.getByRole('heading', { name: 'This reset link has expired' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Request a new link' }),
  ).toBeVisible();

  loseResponse = true;
  await page.goto('/reset-password?token=one-time-token');
  await page
    .getByLabel('New password', { exact: true })
    .fill('a new secure password value');
  await page
    .getByLabel('Confirm new password', { exact: true })
    .fill('a new secure password value');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(
    page.getByText(/Your password may have changed; try signing in/u),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Try signing in' }),
  ).toBeVisible();
});

test('keeps account security understandable and usable on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockIdentity(page, { authenticated: true });
  await page.route('**/v1/auth/account-security', async (route) => {
    await route.fulfill({
      json: {
        email: user.email,
        emailVerified: true,
        availableProviders: ['google'],
        methods: [
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            kind: 'password',
            provider: null,
          },
        ],
      },
    });
  });
  await page.route('**/v1/auth/account-security/sessions', async (route) => {
    await route.fulfill({
      json: {
        items: [
          {
            id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            current: true,
            createdAt: '2026-09-22T20:00:00.000Z',
            updatedAt: '2026-09-22T20:05:00.000Z',
            expiresAt: '2026-09-29T20:00:00.000Z',
            ipAddress: null,
            userAgent: 'Chromium',
          },
        ],
      },
    });
  });

  await page.goto('/account/security');
  await expect(
    page.getByRole('heading', { name: 'Account & security' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  await page.getByRole('tab', { name: 'Sign-in & security' }).click();
  await expect(
    page.getByRole('heading', { name: 'Sign-in methods' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Password', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('tab', { name: 'Sessions' }).click();
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await expect(page.getByText('This device')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('confirms method and session removal before sending security commands', async ({
  page,
}) => {
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
  await mockIdentity(page, { authenticated: true });
  let removedMethods = 0;
  let endedSessions = 0;
  let methods = [
    {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      kind: 'password',
      provider: null,
    },
    {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      kind: 'social',
      provider: 'google',
    },
  ];
  let sessions = [
    { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', current: true },
    { id: '99999999-9999-4999-8999-999999999999', current: false },
  ];
  await page.route('**/v1/auth/account-security', async (route) => {
    await route.fulfill({
      json: {
        email: user.email,
        emailVerified: true,
        availableProviders: ['google'],
        methods,
      },
    });
  });
  await page.route('**/v1/auth/account-security/sessions', async (route) => {
    await route.fulfill({
      json: {
        items: sessions.map((session) => ({
          ...session,
          createdAt: '2026-09-22T20:00:00.000Z',
          updatedAt: '2026-09-22T20:05:00.000Z',
          expiresAt: '2026-09-29T20:00:00.000Z',
          ipAddress: null,
          userAgent: session.current ? 'This browser' : 'Other Chromium',
        })),
      },
    });
  });
  await page.route(
    '**/v1/auth/account-security/methods/unlink',
    async (route) => {
      removedMethods += 1;
      expect(route.request().postDataJSON()).toMatchObject({
        methodId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      });
      methods = methods.filter((method) => method.provider !== 'google');
      await route.fulfill({ json: { unlinked: true } });
    },
  );
  await page.route(
    '**/v1/auth/account-security/sessions/revoke-others',
    async (route) => {
      endedSessions += 1;
      sessions = sessions.filter((session) => session.current);
      await route.fulfill({ json: { revokedCount: 1 } });
    },
  );

  await page.goto('/account/security');
  await page.getByRole('tab', { name: 'Sign-in & security' }).click();
  await page.getByRole('button', { name: 'Remove Google' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Remove sign-in method?' }),
  ).toBeVisible();
  expect(removedMethods).toBe(0);
  await page.getByRole('button', { name: 'Keep method' }).click();
  expect(removedMethods).toBe(0);
  await page.getByRole('button', { name: 'Remove Google' }).click();
  await page.getByRole('button', { name: 'Remove method' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Remove sign-in method?' }),
  ).toBeHidden();
  expect(removedMethods).toBe(1);
  await expect(
    page.getByRole('list', { name: 'Sign-in methods' }).getByText('Google'),
  ).toHaveCount(0);

  await page.getByRole('tab', { name: 'Sessions' }).click();
  await page
    .getByRole('button', { name: 'Sign out all other devices' })
    .click();
  const confirmation = page.getByRole('dialog', {
    name: 'Sign out all other devices?',
  });
  await expect(confirmation).toBeVisible();
  expect(endedSessions).toBe(0);
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  expect(endedSessions).toBe(0);
  await page
    .getByRole('button', { name: 'Sign out all other devices' })
    .click();
  await confirmation
    .getByRole('button', { name: 'Sign out', exact: true })
    .click();
  await expect(page.getByText('No other devices are signed in.')).toBeVisible();
  expect(endedSessions).toBe(1);
});

test('requires an existing-method challenge before starting provider linking', async ({
  page,
}) => {
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
  await mockIdentity(page, { authenticated: true });
  await page.route('**/v1/auth/account-security', async (route) => {
    await route.fulfill({
      json: {
        email: user.email,
        emailVerified: true,
        availableProviders: ['google'],
        methods: [
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            kind: 'password',
            provider: null,
          },
        ],
      },
    });
  });
  await page.route('**/v1/auth/account-security/sessions', async (route) => {
    await route.fulfill({ json: { items: [] } });
  });
  let starts = 0;
  await page.route(
    '**/v1/auth/account-security/methods/link/start',
    async (route) => {
      starts += 1;
      expect(route.request().headers()['x-csrf-token']).toBe(csrfToken);
      expect(route.request().postDataJSON()).toEqual({
        provider: 'google',
        existingMethod: {
          kind: 'password',
          password: 'correct horse battery staple',
        },
      });
      await route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://pertexo.test/problems/auth.provider_unavailable',
          title: 'Provider unavailable',
          status: 503,
          code: 'auth.provider_unavailable',
          requestId: 'browser-request-1234',
        }),
      });
    },
  );

  await page.goto('/account/security');
  await page.getByRole('tab', { name: 'Sign-in & security' }).click();
  await page.getByRole('button', { name: 'Add a sign-in method' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a sign-in method' });
  await dialog.getByRole('button', { name: 'Continue to Google' }).click();
  await expect(dialog.getByLabel('Current password')).toBeFocused();
  expect(starts).toBe(0);
  await dialog
    .getByLabel('Current password')
    .fill('correct horse battery staple');
  await dialog.getByRole('button', { name: 'Continue to Google' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(starts).toBe(1);
});

test('offers legacy migration only when configured and retains manual recovery on failure', async ({
  page,
}) => {
  await mockIdentity(page, { authenticated: false });
  await page.route('**/v1/auth/capabilities', async (route) => {
    await route.fulfill({
      json: {
        password: {
          enabled: true,
          minimumLength: 12,
          verificationRequired: true,
        },
        socialProviders: ['google'],
        legacyMigrationAvailable: true,
      },
    });
  });
  let starts = 0;
  await page.route('**/v1/auth/legacy-migration/start', async (route) => {
    starts += 1;
    expect(route.request().postDataJSON()).toEqual({ provider: 'google' });
    await route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'https://pertexo.test/problems/auth.provider_unavailable',
        title: 'Provider unavailable',
        status: 503,
        code: 'auth.provider_unavailable',
        requestId: 'browser-request-1234',
      }),
    });
  });

  await page.goto('/account/migrate');
  await expect(
    page.getByRole('heading', { name: 'Move your sign-in' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Your existing account was not changed',
  );
  expect(starts).toBe(1);
  await expect(
    page.getByRole('link', { name: 'Back to sign in' }),
  ).toBeVisible();
});
