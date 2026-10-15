import { expect, test } from '../support/fixtures';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workflowSummary,
  workspaceId,
  workspace,
} from '../workflow-editor/support';
import { workflowListBody } from './list-support';

for (const width of [1280, 390]) {
  test(`searches and organizes workflows through compact controls at ${String(width)}px`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 768 });
    await addCsrfCookie(context);
    await installEditorRoutes(page, remoteDraft());
    const reads: URL[] = [];
    const workflow = workflowSummary('Daily intake').workflow;
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows?**`,
      async (route) => {
        const url = new URL(route.request().url());
        reads.push(url);
        await route.fulfill({
          json: workflowListBody(
            url.href,
            url.searchParams.has('query') ? [] : [workflow],
          ),
        });
      },
    );
    let finishFavorite!: () => Promise<void>;
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/favorite`,
      async (route) => {
        await new Promise<void>((resolve) => {
          finishFavorite = async () => {
            await route.fulfill({
              status: 503,
              contentType: 'application/problem+json',
              json: {
                type: 'urn:pertexo:problem:internal.unexpected',
                title: 'Try again',
                status: 503,
                code: 'internal.unexpected',
                requestId: 'favorite-outage',
              },
            });
            resolve();
          };
        });
      },
    );
    await page.goto(`/w/${workspaceId}/workflows`);
    const row = page.getByRole('link', { name: 'Daily intake' });
    await expect(row).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: 'Find and organize workflows' })
        .getByRole('button', { name: 'Search', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Organize selected…' }),
    ).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Select Daily intake' }).check();
    await expect(
      page.getByRole('button', { name: 'Organize selected…' }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Clear selection' }).click();
    await expect(
      page.getByRole('button', { name: 'Organize selected…' }),
    ).toHaveCount(0);
    const search = page.getByRole('searchbox', { name: 'Search workflows' });
    await search.pressSequentially('Daily intake ');
    await expect(search).toHaveValue('Daily intake ');
    await expect(page).toHaveURL(/query=Daily(?:%20|\+)intake(?:%20|\+)/u);
    await expect(
      page.getByText('No workflows match these filters'),
    ).toBeVisible();
    expect(reads.at(-1)?.searchParams.get('query')).toBe('Daily intake');
    await page.reload();
    await expect(search).toHaveValue('Daily intake ');
    await page.getByRole('button', { name: /^Filters/u }).click();
    await expect(
      page.getByRole('combobox', { name: 'Filter by folder' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Archived', exact: true }).click();
    await expect(page).toHaveURL(/view=archived/u);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(row).toBeVisible();
    await expect(page).not.toHaveURL(/query=|view=/u);
    await page.getByRole('button', { name: /^Filters/u }).press('Escape');
    await page
      .getByRole('button', { name: 'Actions for Daily intake' })
      .click();
    await expect(
      page.getByRole('menuitem', { name: 'Organize…', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('menuitem', { name: 'Add favorite', exact: true })
      .click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Actions for Daily intake' })
      .click();
    await expect(
      page.getByRole('menuitem', { name: 'Saving favorite…' }),
    ).toBeDisabled();
    await page.getByRole('menu').press('Escape');
    await expect.poll(() => typeof finishFavorite).toBe('function');
    await finishFavorite();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Favorite not saved' }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await testInfo.attach('compact workflow controls', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
}

for (const width of [1280, 390]) {
  test(`hands viewer row menus back to their trigger at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await addCsrfCookie(context);
    await installEditorRoutes(page, remoteDraft(), {
      accessibleWorkspace: {
        ...workspace,
        role: 'viewer',
        capabilities: ['workspace:read', 'workflow:read', 'run:read'],
      },
    });
    const alpha = workflowSummary('Alpha').workflow;
    const beta = {
      ...workflowSummary('Beta').workflow,
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    };
    await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
      route.fulfill({
        json: workflowListBody(route.request().url(), [alpha, beta]),
      }),
    );
    await page.goto(`/w/${workspaceId}/workflows`);
    for (const name of ['Alpha', 'Beta', 'Alpha']) {
      const trigger = page.getByRole('button', {
        name: `Actions for ${name}`,
        exact: true,
      });
      await trigger.click();
      const menu = page.getByRole('menu', {
        name: `Actions for ${name}`,
        exact: true,
      });
      await expect(
        menu.getByRole('menuitem', { name: 'Add favorite', exact: true }),
      ).toBeEnabled();
      await expect(
        menu.getByRole('menuitem', { name: 'Organize…', exact: true }),
      ).toHaveCount(0);
      // Escape belongs to the open popup, including before its autofocus settles.
      await menu.press('Escape');
      await expect(menu).not.toBeVisible();
      await expect(trigger).toBeFocused();
    }
  });
}
