import { expect, type Page } from '@playwright/test';
import {
  addSingleStep,
  createEditorWorkflow,
} from '../support/authoring/single-step';
import { test } from '../support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../support/ordinary-editor-session';

/*
 * The real built app behind the real production nginx config, on a fresh
 * install with default settings. The order is the order of an install: the
 * first person to arrive takes the only open seat.
 */
const violations: string[] = [];
let ownerEmail: string | undefined;

function watchPolicy(page: Page) {
  page.on('console', (message) => {
    if (/Content Security Policy/iu.test(message.text()))
      violations.push(message.text());
  });
  page.on('pageerror', (error) => {
    if (/Content Security Policy|EvalError/iu.test(error.message))
      violations.push(error.message);
  });
}

test('the first person signs up and builds in the editor without a policy violation', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const mail = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mail === undefined) throw new Error('Use the owned security journey');
  watchPolicy(page);

  ownerEmail = await registerEditorUser(page, request, mail, 'First owner');
  const workspaceId = await createEditorWorkspace(page, 'Owner workspace');
  const path = await createEditorWorkflow(page, workspaceId, 'Under policy');
  await addSingleStep(page, path, /^Set fields\b/u, 'Fill in');
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  // Far enough to draw the review; the publish request itself isn't a page.
  await page.getByRole('button', { name: 'Publish v1', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Publish v1', exact: true }),
  ).toBeVisible();

  expect(violations).toEqual([]);
});

test('signing back in works under the policy', async ({ page }) => {
  if (ownerEmail === undefined) throw new Error('The first test must run');
  watchPolicy(page);

  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(ownerEmail);
  await page
    .getByLabel('Password', { exact: true })
    .fill('a long enough integration password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/w\/|\/workspaces/u);

  expect(violations).toEqual([]);
});

test('the pages carry a policy that stops injected script', async ({
  page,
}) => {
  test.fail(true, 'sec-04: frame-ancestors is the whole policy today');
  const response = await page.goto('/login');
  const policy = response?.headers()['content-security-policy'] ?? '';
  expect(policy).toMatch(/script-src[^;]*'self'/u);
  expect(policy).not.toMatch(/script-src[^;]*'unsafe-(?:inline|eval)'/u);

  const ran = await page.evaluate(() => {
    const element = document.createElement('script');
    element.textContent = 'window.__injectedScriptRan = true';
    document.head.append(element);
    return Reflect.get(window, '__injectedScriptRan') === true;
  });
  expect(ran).toBe(false);
});

test('the shipped scripts carry the same policy', async ({ page, request }) => {
  test.fail(true, 'sec-04: /assets/ sets its own headers and drops the policy');
  await page.goto('/login');
  const script = await page
    .locator('script[src^="/assets/"]')
    .first()
    .getAttribute('src');
  if (script === null) throw new Error('The app shipped no bundled script');

  const asset = await request.get(script);

  expect(asset.headers()['content-security-policy']).toMatch(
    /script-src[^;]*'self'/u,
  );
});

test('with an owner in place, sign-in offers no way to make an account', async ({
  page,
}) => {
  test.fail(true, 'docs-deps-product-01: self-service sign-up is always shown');
  await page.goto('/login');
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Create an account', exact: true }),
  ).toHaveCount(0);
});

test('with an owner in place, the sign-up page says to ask for an invitation', async ({
  page,
}) => {
  test.fail(true, 'docs-deps-product-01: the form is always shown');
  await page.goto('/sign-up');
  await expect(page.getByText(/invitation/iu).first()).toBeVisible();
  await expect(page.getByLabel('Email', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Create account', exact: true }),
  ).toHaveCount(0);
});
