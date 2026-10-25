import { expect, test } from '../../support/fixtures';

import {
  routeEmptyWorkflowOrganization,
  workflowListBody,
} from '../../workflows/list-support';

import {
  csrfToken,
  mockIdentity,
  user,
  workspace,
  workspaceId,
} from './fixture';

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

  // With a phone keyboard up, the bar steps out of the way of the page.
  // By CSS, not role: a hidden bar leaves the accessibility tree.
  const barBox = page
    .locator('nav[aria-label="Workspace"]')
    .filter({ hasText: 'More' });
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Search pages, workflows and actions' }),
  ).toBeFocused();
  await expect(barBox).toHaveCSS('visibility', 'hidden');
  await page.keyboard.press('Escape');
  await expect(barBox).toHaveCSS('visibility', 'visible');

  // A link that stays in the workspace closes More too.
  await trigger.press('Enter');
  await drawer.getByRole('link', { name: 'Account & security' }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/account$`, 'u'));
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
        webhookSetupRequired: false,
        publishedVersionId: null,
        createdAt: '2026-09-14T10:00:00.000Z',
        updatedAt: '2026-09-14T10:00:00.000Z',
      };
      if (path.endsWith('/draft')) {
        await route.fulfill({
          headers: {
            'content-type': 'application/json',
            etag: `"draft.${'a'.repeat(43)}"`,
          },
          body: JSON.stringify({
            workflowId: createdWorkflowId,
            revision: 1,
            graph: { nodes: [], edges: [], settings: {} },
            compatibility: {
              compatible: true,
              fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
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
  await routeEmptyWorkflowOrganization(page, createdId);
  await page.route(
    `**/v1/workspaces/${createdId}/workflows?**`,
    async (route) => {
      await route.fulfill({
        json: workflowListBody(route.request().url(), []),
      });
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
  // The form is on screen before tabbing into it: on a busy machine the
  // heading can paint a moment before the fields do.
  await expect(page.getByLabel('Email')).toBeVisible();
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

for (const [width, height] of [
  [390, 844],
  [375, 667],
] as const)
  test(`sign-in fits a ${String(width)}×${String(height)} phone without scrolling`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await mockIdentity(page, { authenticated: false });
    await page.goto('/login');
    await expect(
      page.getByRole('button', { name: 'Sign in', exact: true }),
    ).toBeVisible();
    // Nothing waits below the form: the page's one job is the lens.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      ),
    ).toBeLessThanOrEqual(0);
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
