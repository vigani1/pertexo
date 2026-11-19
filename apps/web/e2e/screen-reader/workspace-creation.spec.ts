import { expect, test } from '../support/fixtures';
import {
  expectFocusOn,
  expectSpoken,
  startScreenReader,
} from '../support/screen-reader';
import {
  routeEmptyWorkflowOrganization,
  workflowListBody,
} from '../workflows/list-support';
import { csrfToken, mockIdentity, workspace } from '../workspace/auth/fixture';

const createdId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

test('a screen-reader user creates the first workspace past a lost answer and a taken handle', async ({
  page,
}) => {
  const created = {
    ...workspace,
    id: createdId,
    name: 'Signal Operations',
    slug: 'signal-operations',
  };
  let workspaces: unknown[] = [];
  let attempts = 0;
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
  await mockIdentity(page, { authenticated: true, workspaces: [] });
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({ json: { items: workspaces, nextCursor: null } }),
  );
  await page.route('**/v1/workspaces', async (route) => {
    attempts += 1;
    // The first answer is lost on the way back, the second finds the handle
    // taken, the third creates the workspace.
    if (attempts === 1) {
      await route.abort('failed');
      return;
    }
    if (attempts === 2) {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        json: {
          type: 'https://pertexo.test/problems/workspace.conflict',
          title: 'Conflict',
          status: 409,
          code: 'workspace.conflict',
          requestId: 'browser-request-handle',
        },
      });
      return;
    }
    workspaces = [created];
    await route.fulfill({
      status: 201,
      json: {
        id: createdId,
        name: created.name,
        slug: (route.request().postDataJSON() as { slug: string }).slug,
        status: 'active',
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      },
    });
  });
  await routeEmptyWorkflowOrganization(page, createdId);
  await page.route(`**/v1/workspaces/${createdId}/workflows?**`, (route) =>
    route.fulfill({ json: workflowListBody(route.request().url(), []) }),
  );
  await page.route(`**/v1/workspaces/${createdId}/connections?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );

  await page.goto('/workspaces');
  await expect(
    page.getByRole('heading', { name: 'Create your workspace' }),
  ).toBeVisible();
  await startScreenReader(page);
  const name = page.getByRole('textbox', { name: 'Workspace name' });
  await name.focus();
  await expectSpoken(page, /^textbox, Workspace name/u);
  await page.keyboard.type('Signal Operations');
  await page.keyboard.press('Enter');

  // An unconfirmed create keeps the user in the form, told it is safe to
  // send again.
  await expect(page.getByRole('alert')).toContainText(
    'We couldn’t confirm whether the workspace was created.',
  );
  await expectFocusOn(page, 'textbox', 'Workspace name');
  await page.keyboard.press('Enter');

  // A taken handle opens the handle field, focused, described by the reason.
  const handle = page.getByRole('textbox', { name: 'Handle' });
  await expect(handle).toBeFocused();
  await expect(handle).toHaveAttribute('aria-invalid', 'true');
  await expect(handle).toHaveAccessibleDescription(
    /That handle is already taken\. Choose another one\./u,
  );
  await page.keyboard.press('End');
  await page.keyboard.type('-team');
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(`/w/${createdId}`);
  await expect(
    page
      .getByRole('navigation', { name: 'Workspace' })
      .getByRole('link', { name: 'Home' }),
  ).toHaveAttribute('aria-current', 'page');
  expect(attempts).toBe(3);
});
