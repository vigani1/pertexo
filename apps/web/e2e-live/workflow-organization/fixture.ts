import { workflowOrganizationProjectionResponseSchema } from '@pertexo/contracts';
import { expect, type Locator, type Page } from '@playwright/test';
export const observation: {
  lastIdentityStatus: number;
  failedControl: {
    action: 'favorite' | 'invitation' | 'other';
    matches: number;
    enabled: boolean | null;
  } | null;
} = { lastIdentityStatus: 0, failedControl: null };

export async function choose(page: Page, control: Locator, option: string) {
  await expect(control).toBeEnabled();
  await control.focus();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('option', { name: option, exact: true }).click();
}

export function row(page: Page, name: string) {
  return page
    .getByRole('list', { name: 'Workflows', exact: true })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name, exact: true }) });
}

export async function createWorkflow(
  page: Page,
  workspaceId: string,
  name: string,
  phase: (value: string) => Promise<void>,
) {
  await phase('workflow-navigation');
  await page.goto(`/w/${workspaceId}/workflows`);
  await phase('workflow-open');
  await page.getByRole('button', { name: 'New workflow', exact: true }).click();
  await phase('workflow-name');
  await page.getByLabel('Workflow name', { exact: true }).fill(name);
  await phase('workflow-submit');
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/v1/workspaces/${workspaceId}/workflows` &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Create workflow', exact: true })
    .click();
  const createdResponse = await created;
  await phase(
    createdResponse.status() === 201
      ? 'workflow-created'
      : 'workflow-create-rejected',
  );
  expect(createdResponse.status()).toBe(201);
  await phase('workflow-result');
  try {
    await expect(page).toHaveURL(/\/workflows\/[^/?]+(?:\?.*)?$/u);
  } catch {
    if (new URL(page.url()).pathname.startsWith(`/w/${workspaceId}/`))
      await page.screenshot({
        path: '/tmp/pertexo-f07-creation-public.png',
        fullPage: true,
      });
    throw new Error('Ordinary created workflow navigation unavailable');
  }
  const workflowId = new URL(page.url()).pathname.split('/')[4];
  if (workflowId === undefined)
    throw new Error('Created workflow identifier unavailable');
  return workflowId;
}

export async function command({
  page,
  button,
  suffix,
  status = 200,
  method = 'POST',
}: Readonly<{
  page: Page;
  button: Locator;
  suffix: string;
  status?: number;
  method?: string;
}>) {
  try {
    await expect(button).toBeEnabled();
    // Join both operations so a failed click cannot leave an unhandled waiter
    // that masks the original UI failure with a later response timeout.
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith(suffix) &&
          response.request().method() === method,
      ),
      button.click(),
    ]);
    expect(response.status()).toBe(status);
    return response;
  } catch (error) {
    const matches = await button.count().catch(() => 0);
    observation.failedControl = {
      action: actionForSuffix(suffix),
      matches,
      enabled:
        matches === 1 ? await button.isEnabled().catch(() => null) : null,
    };
    throw error;
  }
}

function actionForSuffix(suffix: string) {
  if (suffix === '/favorite') return 'favorite';
  if (suffix === '/invitations') return 'invitation';
  return 'other';
}

export function ownedRole() {
  const role = process.env.PERTEXO_ORGANIZATION_ROLE;
  switch (role) {
    case 'viewer':
    case 'builder':
    case 'admin':
      return role;
    default:
      throw new Error('Explicit owned role case required');
  }
}

export async function openFilters(page: Page) {
  await page.getByRole('button', { name: /^Filters/u }).click();
  await expect(
    page.getByRole('heading', { name: 'Filter workflows' }),
  ).toBeVisible();
}

export async function closeFilters(page: Page) {
  await page.getByRole('button', { name: /^Filters/u }).press('Escape');
}

export async function openRowMenu(page: Page, name: string) {
  await row(page, name)
    .getByRole('button', { name: `Actions for ${name}`, exact: true })
    .click();
  const menu = page.getByRole('menu', {
    name: `Actions for ${name}`,
    exact: true,
  });
  await expect(menu).toBeVisible();
  return menu;
}

export async function openTags(page: Page) {
  await openFilters(page);
  await page.getByRole('button', { name: 'Manage tags…', exact: true }).click();
}

export function shelf(page: Page) {
  return page.getByRole('region', { name: 'Folders', exact: true });
}

export async function folderAction(
  page: Page,
  folder: string,
  action: 'Rename…' | 'Move to…' | 'Share…' | 'Delete…',
) {
  await shelf(page)
    .getByRole('button', { name: `Actions for ${folder}`, exact: true })
    .click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

export async function organize(
  page: Page,
  name: string,
  operation: 'move' | 'tags',
  destination: string,
) {
  await openRowMenu(page, name);
  await page.getByRole('menuitem', { name: 'Organize…', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Organize workflow',
    exact: true,
  });
  if (operation === 'move') {
    await choose(
      page,
      dialog.getByRole('combobox', { name: 'Folder', exact: true }),
      destination,
    );
    await command({
      page,
      button: dialog.getByRole('button', { name: 'Move selected workflows' }),
      suffix: '/folder',
    });
  } else {
    await dialog
      .getByRole('button', { name: 'Replace tags', exact: true })
      .click();
    await dialog
      .getByRole('checkbox', { name: destination, exact: true })
      .check();
    await command({
      page,
      button: dialog.getByRole('button', { name: 'Replace selected tags' }),
      suffix: '/tags',
    });
  }
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

export async function projection(
  page: Page,
  workspaceId: string,
  workflowId: string,
) {
  const response = await page.request.get(
    `/v1/workspaces/${workspaceId}/workflows/${workflowId}?include=organization`,
  );
  expect(response.status()).toBe(200);
  return workflowOrganizationProjectionResponseSchema.parse(
    await response.json(),
  );
}

export async function favorite(page: Page, name: string) {
  const menu = await openRowMenu(page, name);
  await command({
    page,
    button: menu.getByRole('menuitem', {
      name: 'Add favorite',
      exact: true,
    }),
    suffix: '/favorite',
    status: 200,
    method: 'PUT',
  });
}

export async function lifecycle(
  page: Page,
  name: string,
  action: 'archive' | 'restore',
) {
  await row(page, name)
    .getByRole('button', { name: `Actions for ${name}`, exact: true })
    .click();
  await page
    .getByRole('menuitem', {
      name: action === 'archive' ? 'Archive…' : 'Restore…',
      exact: true,
    })
    .click();
  const dialog = page.getByRole('dialog', {
    name:
      action === 'archive'
        ? 'Archive this workflow?'
        : 'Restore this workflow?',
    exact: true,
  });
  await command({
    page,
    button: dialog.getByRole('button', {
      name: action === 'archive' ? 'Archive' : 'Restore',
      exact: true,
    }),
    suffix: `/${action}`,
    status: 202,
  });
  await expect(dialog).not.toBeVisible();
}

export async function cleanupTag(page: Page, workflowName: string) {
  await openTags(page);
  // The dialog's title follows its view, so find it by role alone.
  const manager = page.getByRole('dialog');
  await manager.getByRole('button', { name: 'ops', exact: true }).click();
  await manager
    .getByRole('button', { name: 'See workflows using it', exact: true })
    .click();
  await manager
    .getByRole('checkbox', {
      name: `Select ${workflowName}`,
      exact: true,
    })
    .check();
  await command({
    page,
    button: manager.getByRole('button', {
      name: 'Detach tag from 1 selected workflows',
      exact: true,
    }),
    suffix: '/cleanup/detach',
  });
  await expect(manager.getByText(/Tag detached/u)).toBeVisible();
  await manager
    .getByRole('button', {
      name: 'Reload assignments and clear selection',
      exact: true,
    })
    .click();
  await expect(
    manager.getByText(/No loaded assignments remain/u),
  ).toBeVisible();
  await manager.getByRole('button', { name: 'Done', exact: true }).click();
}
