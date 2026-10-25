import {
  workflowOrganizationBulkRequestSchema,
  workflowOrganizationBulkResponseSchema,
} from '@pertexo/contracts';
import type { DelegatedRole } from '@pertexo/workflow-model';
import {
  expect,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';
import { invitedActor } from './organization-actors';
import {
  choose,
  cleanupTag,
  closeFilters,
  command,
  favorite,
  lifecycle,
  openFilters,
  openRowMenu,
  organize,
  projection,
  row,
} from './workflow-organization/fixture';
export async function qualifyExtended(input: {
  browser: Browser;
  page: Page;
  request: APIRequestContext;
  mailOrigin: string;
  workspaceId: string;
  alpha: string;
  beta: string;
  folderId: string;
  phase: (value: string) => Promise<void>;
  role: DelegatedRole;
}) {
  const { page, workspaceId, alpha, beta, phase } = input;
  const alphaName = 'Organization Alpha';
  const betaName = 'Organization Beta';
  const listPath = `/w/${workspaceId}/workflows`;
  await phase('partial');
  const concurrent = await page.context().newPage();
  try {
    await concurrent.goto(listPath);
    await page.route(
      '**/workflows/organization/bulk',
      async (route) => {
        const sent = workflowOrganizationBulkRequestSchema.parse(
          route.request().postDataJSON(),
        );
        expect(sent.items.map((item) => item.workflowId)).toEqual([
          beta,
          alpha,
        ]);
        // Another real public UI command wins AFTER the first parent body was
        // frozen. The server, not a mock, produces the per-item conflict.
        await organize(concurrent, alphaName, 'move', 'Unfiled / top level');
        const actual = await route.fetch();
        expect(actual.status()).toBe(200);
        const result = workflowOrganizationBulkResponseSchema.parse(
          await actual.json(),
        );
        expect(
          result.items.map((item) => ({
            id: item.workflowId,
            status: item.status,
          })),
        ).toEqual([
          { id: beta, status: 'updated' },
          { id: alpha, status: 'conflict' },
        ]);
        await route.fulfill({ response: actual });
      },
      { times: 1 },
    );
    await row(page, betaName)
      .getByRole('checkbox', { name: `Select ${betaName}`, exact: true })
      .check();
    await row(page, alphaName)
      .getByRole('checkbox', { name: `Select ${alphaName}`, exact: true })
      .check();
    await page
      .getByRole('button', { name: 'Organize selected…', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Organize 2 workflows',
      exact: true,
    });
    await choose(
      page,
      dialog.getByRole('combobox', { name: 'Folder', exact: true }),
      'Unfiled / top level',
    );
    await command({
      page,
      button: dialog.getByRole('button', {
        name: 'Move selected workflows',
        exact: true,
      }),
      suffix: '/bulk',
    });
    // The HTTP receipt precedes the command's final authority check.
    await expect(
      dialog.getByRole('button', { name: 'Close', exact: true }),
    ).toBeEnabled({ timeout: 15_000 });
    const outcomes = dialog
      .getByRole('region', {
        name: 'Organization command outcomes',
        exact: true,
      })
      .getByRole('listitem');
    await expect(outcomes).toHaveCount(2);
    await expect(outcomes.nth(0)).toContainText(betaName);
    await expect(outcomes.nth(0)).toContainText('Updated');
    await expect(outcomes.nth(1)).toContainText(alphaName);
    await expect(outcomes.nth(1)).toContainText(
      'Conflict — organization changed',
    );
    await expect(
      dialog.getByRole('button', {
        name: 'Retry original request',
        exact: true,
      }),
    ).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    expect(
      (await projection(page, workspaceId, alpha)).organization.folderId,
    ).toBe(null);
    expect(
      (await projection(page, workspaceId, beta)).organization.folderId,
    ).toBe(null);
  } finally {
    await concurrent.close();
  }
  await expect(
    page.getByRole('button', { name: 'Clear selection', exact: true }),
  ).toHaveCount(0);
  await phase('roles');
  await organize(page, betaName, 'tags', 'ops');
  if (input.role === 'admin') {
    await lifecycle(page, betaName, 'archive');
  }
  for (const role of [input.role]) {
    const actor = await invitedActor({ ...input, owner: page, role });
    try {
      await expect(row(actor.page, alphaName)).toBeVisible();
      expect(
        (await projection(actor.page, workspaceId, alpha)).organization
          .isFavorite,
      ).toBe(false);
      expect(
        (await projection(page, workspaceId, alpha)).organization.isFavorite,
      ).toBe(true);
      if (role === 'viewer') {
        await openFilters(actor.page);
        await expect(
          actor.page.getByRole('button', {
            name: 'Manage tags…',
            exact: true,
          }),
        ).toHaveCount(0);
        await closeFilters(actor.page);
        const alphaMenu = await openRowMenu(actor.page, alphaName);
        await expect(
          actor.page.getByRole('menuitem', { name: 'Organize…', exact: true }),
        ).toHaveCount(0);
        await alphaMenu.press('Escape');
        await expect(alphaMenu).not.toBeVisible();
        await expect(
          row(actor.page, alphaName).getByRole('checkbox', {
            name: `Select ${alphaName}`,
            exact: true,
          }),
        ).toHaveCount(0);
        await favorite(actor.page, betaName);
        expect(
          (await projection(actor.page, workspaceId, beta)).organization
            .isFavorite,
        ).toBe(true);
        expect(
          (await projection(page, workspaceId, beta)).organization.isFavorite,
        ).toBe(false);
        await openFilters(actor.page);
        await actor.page
          .getByRole('button', { name: 'My favorites', exact: true })
          .click();
        await closeFilters(actor.page);
        await expect(row(actor.page, betaName)).toBeVisible();
        await expect(row(actor.page, alphaName)).toHaveCount(0);
        await actor.page.setViewportSize({ width: 390, height: 844 });
        await actor.page.screenshot({
          path: '/tmp/pertexo-workflow-organization-viewer-mobile.png',
          fullPage: true,
        });
      } else if (role === 'builder') {
        await openFilters(actor.page);
        await expect(
          actor.page.getByRole('button', {
            name: 'Manage tags…',
            exact: true,
          }),
        ).toHaveCount(0);
        await closeFilters(actor.page);
        await organize(actor.page, alphaName, 'move', 'Delivery');
        expect(
          (await projection(page, workspaceId, alpha)).organization.folderId,
        ).toBe(input.folderId);
        await page.goto(listPath);
        await lifecycle(page, betaName, 'archive');
        await actor.page.goto(`${listPath}?view=archived`);
        await expect(row(actor.page, betaName)).toBeVisible();
        await openRowMenu(actor.page, betaName);
        await expect(
          actor.page.getByRole('menuitem', { name: 'Organize…', exact: true }),
        ).toHaveCount(0);
        await actor.page.keyboard.press('Escape');
      } else {
        await openFilters(actor.page);
        await expect(
          actor.page.getByRole('button', {
            name: 'Manage tags…',
            exact: true,
          }),
        ).toBeVisible();
        await actor.page.goto(`${listPath}?view=archived`);
        await expect(row(actor.page, betaName)).toBeVisible();
        await organize(actor.page, betaName, 'move', 'Delivery');
        expect(
          (await projection(page, workspaceId, beta)).organization.folderId,
        ).toBe(input.folderId);
        await openRowMenu(actor.page, betaName);
        await actor.page
          .getByRole('menuitem', { name: 'Organize…', exact: true })
          .click();
        const dialog = actor.page.getByRole('dialog', {
          name: 'Organize workflow',
          exact: true,
        });
        await dialog
          .getByRole('button', { name: 'Replace tags', exact: true })
          .click();
        await expect(
          dialog.getByRole('button', {
            name: 'Replace selected tags',
            exact: true,
          }),
        ).toBeDisabled();
        await dialog
          .getByRole('button', { name: 'Close', exact: true })
          .click();
      }
    } finally {
      await actor.close();
    }
  }
  await phase('archive');
  if (
    (await projection(page, workspaceId, beta)).workflow.lifecycleStatus ===
    'active'
  ) {
    await page.goto(listPath);
    await lifecycle(page, betaName, 'archive');
  }
  await page.goto(`${listPath}?view=archived`);
  await organize(page, betaName, 'move', 'Unfiled / top level');
  expect(
    (await projection(page, workspaceId, beta)).workflow.lifecycleStatus,
  ).toBe('archived');
  expect(
    (await projection(page, workspaceId, beta)).organization.folderId,
  ).toBe(null);
  await cleanupTag(page, betaName);
  const cleaned = await projection(page, workspaceId, beta);
  expect(cleaned.workflow.lifecycleStatus).toBe('archived');
  expect(cleaned.organization.tags).toHaveLength(0);
  await lifecycle(page, betaName, 'restore');
  await page.goto(listPath);
  await expect(row(page, betaName)).toBeVisible();
  const receipt = await input.request.post(
    `${input.mailOrigin}/organization-matrix`,
    {
      data: {
        workspaceId,
        workflowIds: [alpha, beta],
        role: input.role,
        partialStatuses: ['updated', 'conflict'],
        privateReadIsolation: true,
        privateWriteIsolation: input.role === 'viewer',
        archivedMove: true,
        archivedTagCleanup: true,
        restored: true,
        roleEditingBoundary: true,
      },
    },
  );
  expect(receipt.status()).toBe(204);
}
