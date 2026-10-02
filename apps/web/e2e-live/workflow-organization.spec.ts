import { expect, type Locator, type Page } from '@playwright/test';
import {
  workflowOrganizationProjectionResponseSchema,
  workflowOrganizationBulkRequestSchema,
  workflowOrganizationBulkResponseSchema,
  workflowFolderCreateResponseSchema,
  workflowTagCreateResponseSchema,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { test } from './support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from './support/ordinary-editor-session';

test.afterEach(async ({ request, page }, info) => {
  if (
    info.status === 'passed' ||
    process.env.PERTEXO_LIVE_MAIL_ORIGIN === undefined
  )
    return;
  const line = Number(
    info.error?.stack?.match(/workflow-organization\.spec\.ts:(\d+)/u)?.[1] ??
      0,
  );
  await request.post(
    `${process.env.PERTEXO_LIVE_MAIL_ORIGIN}/organization-failure`,
    { data: { line } },
  );
  if (/^\/w\/[0-9a-f-]+\//u.test(new URL(page.url()).pathname))
    await page.screenshot({
      path: '/tmp/pertexo-f07-creation-public.png',
      fullPage: true,
    });
});

async function choose(page: Page, control: Locator, option: string) {
  await expect(control).toBeEnabled();
  await control.focus();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('option', { name: option, exact: true }).click();
}
function row(page: Page, name: string) {
  return page
    .getByRole('list', { name: 'Workflows', exact: true })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name, exact: true }) });
}
async function createWorkflow(
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
async function command(
  page: Page,
  button: Locator,
  suffix: string,
  status = 200,
) {
  const replied = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith(suffix) &&
      response.request().method() === 'POST',
  );
  await expect(button).toBeEnabled();
  await button.click();
  const response = await replied;
  expect(response.status()).toBe(status);
  return response;
}
async function organize(
  page: Page,
  name: string,
  operation: 'move' | 'tags',
  destination: string,
) {
  await row(page, name)
    .getByRole('button', { name: 'Organize…', exact: true })
    .click();
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
    await command(
      page,
      dialog.getByRole('button', { name: 'Move selected workflows' }),
      '/folder',
    );
  } else {
    await dialog
      .getByRole('button', { name: 'Replace tags', exact: true })
      .click();
    await dialog
      .getByRole('checkbox', { name: destination, exact: true })
      .check();
    await command(
      page,
      dialog.getByRole('button', { name: 'Replace selected tags' }),
      '/tags',
    );
  }
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test('ordinary owner persists shared organization, exact recovery and private discovery filters', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (
    mailOrigin === undefined ||
    process.env.F07_ORGANIZATION_OWNED_FIXTURE !== 'true'
  )
    throw new Error('Use the owned F07 organization fixture');
  const phase = async (value: string) => {
    const response = await request.post(`${mailOrigin}/organization-phase`, {
      data: { phase: value },
    });
    expect(response.status()).toBe(204);
  };
  await phase('registration');
  await registerEditorUser(page, request, mailOrigin, 'Organization owner');
  await phase('workspace');
  const workspaceId = await createEditorWorkspace(
    page,
    'Organization qualification',
  );
  const alphaName = 'Organization Alpha';
  await phase('workflows');
  const betaName = 'Organization Beta';
  const alpha = await createWorkflow(page, workspaceId, alphaName, phase);
  const beta = await createWorkflow(page, workspaceId, betaName, phase);
  const listPath = `/w/${workspaceId}/workflows`;
  await page.goto(listPath);
  await phase('manager');
  await page.getByRole('button', { name: 'Manage folders and tags…' }).click();
  const manager = page.getByRole('dialog', {
    name: 'Manage workflow organization',
  });
  await phase('folders');
  await manager.getByLabel('Folder name', { exact: true }).fill('Operations');
  const parentReply = await command(
    page,
    manager.getByRole('button', { name: 'Create folder', exact: true }),
    '/workflow-folders',
    201,
  );
  const parent = workflowFolderCreateResponseSchema.parse(
    await parentReply.json(),
  ).folder;
  await expect(
    manager.getByRole('button', { name: 'Edit folder Operations' }),
  ).toBeVisible();
  await manager.getByLabel('Folder name', { exact: true }).fill('Child');
  await choose(
    page,
    manager.getByRole('combobox', { name: 'Parent folder' }),
    'Operations',
  );
  const childReply = await command(
    page,
    manager.getByRole('button', { name: 'Create folder', exact: true }),
    '/workflow-folders',
    201,
  );
  const child = workflowFolderCreateResponseSchema.parse(
    await childReply.json(),
  ).folder;
  expect(child.parentId).toBe(parent.id);
  expect(child.depth).toBe(2);
  await manager.getByRole('button', { name: 'Edit folder Operations' }).click();
  await manager
    .getByRole('button', { name: 'Delete folder', exact: true })
    .click();
  await command(
    page,
    manager.getByRole('button', { name: 'Confirm delete folder' }),
    '/delete',
    409,
  );
  await expect(
    manager.getByText(
      'Move the workflows and child folders out before deleting this folder.',
    ),
  ).toBeVisible();
  await manager.getByRole('button', { name: 'Edit folder Child' }).click();
  await manager.getByLabel('Folder name', { exact: true }).fill('Delivery');
  await command(
    page,
    manager.getByRole('button', { name: 'Rename folder' }),
    '/rename',
  );
  await choose(
    page,
    manager.getByRole('combobox', { name: 'Parent folder' }),
    'Unfiled / top level',
  );
  await command(
    page,
    manager.getByRole('button', { name: 'Move folder', exact: true }),
    '/move',
  );
  await manager.getByLabel('Tag key', { exact: true }).fill('ops');
  await phase('tags');
  const tagReply = await command(
    page,
    manager.getByRole('button', { name: 'Create tag', exact: true }),
    '/workflow-tags',
    201,
  );
  const tag = workflowTagCreateResponseSchema.parse(await tagReply.json()).tag;
  await manager.getByRole('button', { name: 'Close manager' }).click();

  await phase('placement');
  await organize(page, alphaName, 'move', 'Delivery');
  await organize(page, alphaName, 'tags', 'ops');
  await row(page, alphaName)
    .getByRole('button', {
      name: `Manage favorite for ${alphaName}`,
      exact: true,
    })
    .click();
  const favoriteDialog = page.getByRole('dialog', {
    name: 'Personal favorite',
    exact: true,
  });
  await command(
    page,
    favoriteDialog.getByRole('button', {
      name: 'Add favorite',
      exact: true,
    }),
    '/favorite',
  );
  await favoriteDialog
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await page.getByLabel('Name contains', { exact: true }).fill('Alpha');
  await phase('filters');
  await page
    .locator('form')
    .filter({ has: page.getByLabel('Name contains', { exact: true }) })
    .getByRole('button', { name: 'Search', exact: true })
    .click();
  await choose(
    page,
    page.getByRole('combobox', { name: 'Filter by tag' }),
    'ops',
  );
  await choose(
    page,
    page.getByRole('combobox', { name: 'Filter by folder' }),
    'Delivery',
  );
  await page.getByRole('button', { name: 'My favorites', exact: true }).click();
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get('query') === 'Alpha' &&
      url.searchParams.get('tagId') === tag.id &&
      url.searchParams.get('folderId') === child.id &&
      url.searchParams.get('favoritesOnly') === JSON.stringify('true'),
  );
  await expect(row(page, alphaName)).toBeVisible();
  await expect(row(page, betaName)).toHaveCount(0);
  const filtered = new URL(page.url());
  expect(filtered.searchParams.get('query')).toBe('Alpha');
  expect(filtered.searchParams.get('tagId')).toBe(tag.id);
  expect(filtered.searchParams.get('folderId')).toBe(child.id);
  expect(filtered.searchParams.get('favoritesOnly')).toBe(
    JSON.stringify('true'),
  );
  await row(page, alphaName)
    .getByRole('link', { name: alphaName, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${alpha}$`, 'u'));
  await page.goBack();
  await expect(page).toHaveURL(filtered.toString());
  await expect(row(page, alphaName)).toBeVisible();
  await page
    .getByRole('button', { name: 'Clear filters', exact: true })
    .click();
  await organize(page, alphaName, 'move', 'Unfiled / top level');
  await phase('unfile');
  await choose(
    page,
    page.getByRole('combobox', { name: 'Filter by folder' }),
    'Unfiled',
  );
  await expect(row(page, alphaName)).toBeVisible();
  await expect(row(page, betaName)).toBeVisible();
  expect(new URL(page.url()).searchParams.get('folderId')).toBe('root');

  // Lose only a REAL completed response. No response body is fabricated and
  // the same full parent command must replay through current authority.
  let firstBody: unknown;
  await phase('bulk');
  let firstKey: string | undefined;
  await page.route(
    '**/workflows/organization/bulk',
    async (route) => {
      firstBody = workflowOrganizationBulkRequestSchema.parse(
        route.request().postDataJSON(),
      );
      firstKey = route.request().headers()['idempotency-key'];
      const actual = await route.fetch();
      expect(actual.status()).toBe(200);
      const result = workflowOrganizationBulkResponseSchema.parse(
        await actual.json(),
      );
      expect(result.items.every((item) => item.status === 'updated')).toBe(
        true,
      );
      await route.abort('failed');
    },
    { times: 1 },
  );
  await row(page, betaName)
    .getByRole('checkbox', { name: `Select ${betaName}`, exact: true })
    .check();
  await row(page, alphaName)
    .getByRole('checkbox', { name: `Select ${alphaName}`, exact: true })
    .check();
  await page.getByRole('button', { name: 'Organize selected…' }).click();
  const bulk = page.getByRole('dialog', {
    name: 'Organize 2 workflows',
    exact: true,
  });
  await choose(
    page,
    bulk.getByRole('combobox', { name: 'Folder', exact: true }),
    'Delivery',
  );
  await bulk.getByRole('button', { name: 'Move selected workflows' }).click();
  await expect(
    bulk.getByRole('button', { name: 'Retry original request' }),
  ).toBeVisible();
  await expect(
    bulk.getByRole('combobox', { name: 'Folder', exact: true }),
  ).toBeDisabled();
  const replay = await command(
    page,
    bulk.getByRole('button', { name: 'Retry original request' }),
    '/bulk',
  );
  expect(
    workflowOrganizationBulkRequestSchema.parse(
      replay.request().postDataJSON(),
    ),
  ).toEqual(firstBody);
  expect(replay.request().headers()['idempotency-key']).toBe(firstKey);
  expect(
    workflowOrganizationBulkRequestSchema
      .parse(firstBody)
      .items.map((item) => item.workflowId),
  ).toEqual([beta, alpha]);
  expect(
    workflowOrganizationBulkResponseSchema
      .parse(await replay.json())
      .items.every((item) => item.status === 'updated' && item.replayed),
  ).toBe(true);
  await bulk.getByRole('button', { name: 'Close', exact: true }).click();
  await page
    .getByRole('button', { name: 'Clear filters', exact: true })
    .click();

  await phase('cleanup');
  await page.getByRole('button', { name: 'Manage folders and tags…' }).click();
  await manager.getByRole('button', { name: 'Edit tag ops' }).click();
  await manager.getByRole('button', { name: 'Review tag assignments' }).click();
  await manager
    .getByRole('checkbox', { name: `Select workflow ${alpha}`, exact: true })
    .check();
  await command(
    page,
    manager.getByRole('button', {
      name: 'Detach tag from 1 selected workflows',
    }),
    '/cleanup/detach',
  );
  await expect(manager.getByText(/Tag detached/u)).toBeVisible();
  await manager
    .getByRole('button', { name: 'Reload assignments and clear selection' })
    .click();
  await expect(
    manager.getByText(/No loaded assignments remain/u),
  ).toBeVisible();
  await manager.getByRole('button', { name: 'Close manager' }).click();
  await phase('evidence');
  for (const id of [alpha, beta]) {
    const response = await page.request.get(
      `/v1/workspaces/${workspaceId}/workflows/${id}?include=organization`,
    );
    expect(response.status()).toBe(200);
    const current = workflowOrganizationProjectionResponseSchema.parse(
      await response.json(),
    );
    expect(current.organization.folderId).toBe(child.id);
    expect(current.organization.tags).toHaveLength(0);
    expect(current.organization.isFavorite).toBe(id === alpha);
  }
  const evidence = await request.post(`${mailOrigin}/organization-evidence`, {
    data: {
      workspaceId,
      workflowIds: [alpha, beta],
      folderId: child.id,
      tagId: tag.id,
    },
  });
  expect(evidence.status()).toBe(204);
  await page.screenshot({
    path: '/tmp/pertexo-workflow-organization-live.png',
    fullPage: true,
  });
});
