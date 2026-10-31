import { expect, test } from '../support/fixtures';
import { mappingGraph } from '../workflow-editor/graph';
import {
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  user,
  workspaceId,
} from '../workflow-editor/support';

for (const theme of ['light', 'dark'] as const) {
  test(`paints ${theme} before the application module and follows explicit choices on reload`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.route('**/assets/index-*.js', (route) => route.abort());
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(
      await page
        .locator('html')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe(theme === 'light' ? 'rgb(247, 249, 248)' : 'rgb(17, 19, 22)');
    await page.evaluate(
      (value) =>
        window.pertexoAppearance?.setPreference(
          value === 'dark' ? 'dark' : 'light',
        ),
      theme === 'light' ? 'dark' : 'light',
    );
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      theme === 'light' ? 'dark' : 'light',
    );
    // The first frame is the boot screen's wordmark; only the app says what it is doing.
    await expect(page.getByText('Pertexo.', { exact: true })).toBeVisible();
  });
}

test('System follows changes live, explicit choices win, and another tab follows without reload', async ({
  page,
  context,
}) => {
  await installEditorRoutes(page, remoteDraft());
  await page.emulateMedia({ colorScheme: 'light' });
  await page.route('**/v1/auth/account-security', (route) =>
    route.fulfill({
      json: {
        email: user.email,
        emailVerified: true,
        availableProviders: [],
        twoFactor: { enabled: false, recoveryCodesRemaining: null },
        methods: [],
      },
    }),
  );
  await page.goto(`/w/${workspaceId}/account`);
  await expect(
    page.getByRole('heading', { name: 'Appearance', exact: true }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const second = await context.newPage();
  await second.goto('/login');
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'System', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await second.close();
});

test('switches between light and dark from the sidebar', async ({ page }) => {
  await installEditorRoutes(page, remoteDraft());
  await page.emulateMedia({ colorScheme: 'light' });
  await page.route('**/v1/auth/account-security', (route) =>
    route.fulfill({
      json: {
        email: user.email,
        emailVerified: true,
        availableProviders: [],
        twoFactor: { enabled: false, recoveryCodesRemaining: null },
        methods: [],
      },
    }),
  );
  await page.goto(`/w/${workspaceId}/account`);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  // The sidebar and Account → Appearance share one choice.
  await expect(
    page.getByRole('button', { name: 'Dark', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
});

test('blocked storage still paints and permits a choice, with a clear persistence hint', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('Storage is blocked');
      },
    });
  });
  await installEditorRoutes(page, remoteDraft());
  await page.emulateMedia({ colorScheme: 'light' });
  await page.route('**/v1/auth/account-security', (route) =>
    route.fulfill({
      json: {
        email: user.email,
        emailVerified: true,
        availableProviders: [],
        twoFactor: { enabled: false, recoveryCodesRemaining: null },
        methods: [],
      },
    }),
  );
  await page.goto(`/w/${workspaceId}/account`);
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(
    page.getByText('Your browser blocked saving this choice.', {
      exact: false,
    }),
  ).toBeVisible();
});

for (const width of [1440, 990, 375]) {
  test(`account choice is keyboard usable and bounded at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await installEditorRoutes(page, remoteDraft());
    await page.route('**/v1/auth/account-security', (route) =>
      route.fulfill({
        json: {
          email: user.email,
          emailVerified: true,
          availableProviders: [],
          twoFactor: { enabled: false, recoveryCodesRemaining: null },
          methods: [],
        },
      }),
    );
    await page.goto(`/w/${workspaceId}/account`);
    const light = page.getByRole('button', { name: 'Light', exact: true });
    await light.focus();
    await page.keyboard.press('Space');
    await expect(light).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`appearance-light-${String(width)}.png`),
      fullPage: true,
    });
  });
}

test('repaints still canvases and the editor when appearance changes', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await installEditorRoutes(page, remoteDraft(mappingGraph()));
  await page.goto(editorUrl);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await page.evaluate(() => window.pertexoAppearance?.setPreference('light'));
  await expect(page.locator('.react-flow')).toHaveClass(/light/);
  // A still sign-in Core must also redraw, rather than keep dark additive ink.
  await page.route('**/v1/users/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      json: {
        type: 'about:blank',
        title: 'Unauthenticated',
        status: 401,
        code: 'auth.unauthenticated',
        requestId: 'appearance-sign-in',
      },
    }),
  );
  await page.route('**/v1/auth/capabilities', (route) =>
    route.fulfill({
      json: {
        password: {
          enabled: true,
          minimumLength: 12,
          verificationRequired: true,
        },
        socialProviders: [],
        signUp: 'open',
      },
    }),
  );
  await page.goto('/login');
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  const orb = page.locator('[data-slot=core-orb]').first();
  await expect(orb).toBeVisible();
  const before = await orb.evaluate((el) =>
    (el as HTMLCanvasElement).toDataURL(),
  );
  await page.evaluate(() => window.pertexoAppearance?.setPreference('dark'));
  await expect
    .poll(() => orb.evaluate((el) => (el as HTMLCanvasElement).toDataURL()))
    .not.toBe(before);
});
