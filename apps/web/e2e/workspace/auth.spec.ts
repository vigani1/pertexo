import { expect, test } from '../support/fixtures';

import {
  csrfToken,
  mockIdentity,
  unauthenticatedProblem,
  user,
  workspace,
  workspaceId,
} from './auth/fixture';

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
        signUp: 'open',
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
        twoFactor: { enabled: false, recoveryCodesRemaining: null },
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
        webhookSetupRequired: false,
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
