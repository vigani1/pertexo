import { expect, test, type Page } from '../../support/fixtures';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  user,
  workflowSummary,
  workspaceId,
} from '../support';
import { workflowListBody } from '../../workflows/list-support';

test('keeps one presence lease on navigation and detects a second browser tab', async ({
  page,
  context,
}) => {
  await addCsrfCookie(context);
  const leases = new Map<string, number>();
  async function install(tab: Page) {
    await installEditorRoutes(tab, remoteDraft());
    await tab.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
      route.fulfill({
        json: workflowListBody(route.request().url(), [
          workflowSummary('Customer onboarding').workflow,
        ]),
      }),
    );
    await tab.route(
      '**/v1/workspaces/*/workflows/*/presence**',
      async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() === 'PUT') {
          const id = url.pathname.split('/').at(-1) ?? '';
          const body = route.request().postDataJSON() as { sequence: number };
          expect(body.sequence).toBeGreaterThan(leases.get(id) ?? 0);
          leases.set(id, body.sequence);
          await route.fulfill({ json: { accepted: true } });
        } else {
          const others = [...leases.keys()].filter(
            (id) => id !== url.searchParams.get('tabId'),
          );
          await route.fulfill({
            json: {
              people:
                others.length === 0
                  ? []
                  : [
                      {
                        userId: user.id,
                        displayName: user.displayName,
                        editing: false,
                        dirty: false,
                        baseRevision: null,
                        tabCount: others.length,
                      },
                    ],
            },
          });
        }
      },
    );
  }
  await install(page);
  await page.goto(editorUrl);
  await expect.poll(() => leases.size).toBe(1);
  const firstSequence = [...leases.values()][0] ?? 0;
  // Leaving the workflow unmounts its presence provider; returning reuses the lease.
  await page.getByRole('link', { name: 'Back to workflows' }).click();
  await page
    .getByRole('link', { name: 'Customer onboarding', exact: true })
    .click();
  await expect
    .poll(() => [...leases.values()][0] ?? 0)
    .toBeGreaterThan(firstSequence);
  expect(leases.size).toBe(1);
  await expect(
    page.getByText('Also in another tab', { exact: true }),
  ).toHaveCount(0);
  const second = await context.newPage();
  await install(second);
  await second.goto(editorUrl);
  await expect.poll(() => leases.size).toBe(2);
  await expect(
    second.getByText('Also in another tab', { exact: true }),
  ).toBeVisible();
  await second.close();
});
