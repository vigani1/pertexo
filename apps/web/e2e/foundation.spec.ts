import { test, expect } from '@playwright/test';

test('foundation loads without runtime errors and supports keyboard interaction', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'The foundation is ready.',
  );
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: 'Skip to content' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Test interaction' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Interaction works.');
  expect(errors).toEqual([]);
});

test('unknown deep links recover to the foundation', async ({ page }) => {
  await page.goto('/not-a-real-route');
  await expect(
    page.getByRole('heading', { name: 'Page not found' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Back to foundation' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'The foundation is ready.',
  );
});

test('foundation fits a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Test interaction' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
