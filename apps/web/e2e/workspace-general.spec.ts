import { expect, test, type Page } from '@playwright/test';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const timestamp = '2026-09-15T10:00:00.000Z';
const csrfToken = 'csrf-token-for-workspace-lifecycle-tests-1234567890';

async function installRoutes(page: Page) {
  await page.route('**/v1/users/me', (route) =>
    route.fulfill({
      json: {
        id: userId,
        email: 'owner@example.test',
        displayName: 'Workspace Owner',
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    }),
  );
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: workspaceId,
            name: 'Control Operations',
            slug: 'control-operations',
            status: 'active',
            role: 'owner',
            capabilities: ['workspace:read', 'workspace:manage', 'member:read'],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/deletion`,
    async (route) => {
      const request = route.request();
      expect(request.method()).toBe('POST');
      expect(request.headers()['x-csrf-token']).toBe(csrfToken);
      expect(request.headers()['idempotency-key']).toBeTruthy();
      expect(request.postDataJSON()).toEqual({ reason: 'Retiring this space' });
      await route.fulfill({ status: 202, json: lifecycleOperation('pending') });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/lifecycle-operations/${operationId}`,
    (route) => route.fulfill({ json: lifecycleOperation('running') }),
  );
}

function lifecycleOperation(status: 'pending' | 'running') {
  return {
    id: operationId,
    workspaceId,
    commandType: 'deletion_requested',
    status,
    submittedAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    errorCode: null,
    result: null,
  };
}

test('requests deletion through the accessible workspace settings flow', async ({
  page,
}) => {
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
  await installRoutes(page);
  await page.goto(`/w/${workspaceId}/settings/general`);

  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Workspace settings' }),
  ).toHaveAttribute('aria-current', 'page');

  await page.getByRole('button', { name: 'Request deletion' }).click();
  await expect(
    page.getByRole('heading', { name: 'Request workspace deletion?' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('heading', { name: 'Request workspace deletion?' }),
  ).toBeHidden();

  await page.getByRole('button', { name: 'Request deletion' }).click();
  await page.getByLabel('Reason').fill('Retiring this space');
  await page.getByRole('button', { name: 'Request deletion' }).click();

  await expect(page).toHaveURL(
    `/w/${workspaceId}/settings/general?operationId=${operationId}`,
  );
  await expect(page.getByText('Running')).toBeVisible();
  await expect(
    page.getByText(
      'The command was accepted, but the workspace change is not complete yet.',
    ),
  ).toBeVisible();
});
