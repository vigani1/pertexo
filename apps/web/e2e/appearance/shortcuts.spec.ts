import { expect, test } from '../support/fixtures';
import {
  installEditorRoutes,
  remoteDraft,
  workspaceId,
  user,
} from '../workflow-editor/support';

for (const width of [1440, 990, 375]) {
  test(`switches appearance from account menu and command palette at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
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
    if (width < 768) {
      const bar = page.getByRole('navigation', {
        name: 'Workspace',
        exact: true,
      });
      const barBounds = await bar.boundingBox();
      const toastBottom = await page
        .locator('[data-slot="toast-viewport"]')
        .evaluate((el) => el.getBoundingClientRect().bottom);
      if (barBounds === null) throw new Error('Phone navigation missing');
      expect(toastBottom).toBeLessThan(barBounds.y);
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'More', exact: true })
        .getByRole('button', { name: 'Light', exact: true })
        .click();
    } else {
      await page
        .getByRole('button', { name: `Account menu for ${user.displayName}` })
        .click();
      await page
        .getByRole('menuitemradio', { name: 'Light', exact: true })
        .click();
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+k');
    await page
      .getByRole('combobox', { name: 'Search pages, workflows and actions' })
      .fill('Switch theme');
    await page.getByRole('option', { name: 'Switch theme' }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Switch theme',
      exact: true,
    });
    await dialog.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await dialog.getByRole('button', { name: 'System', exact: true }).click();
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('heading', { name: 'Appearance', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`theme-shortcuts-${String(width)}.png`),
      fullPage: true,
    });
  });
}
