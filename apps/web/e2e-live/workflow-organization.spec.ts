import {
  workflowFolderCreateResponseSchema,
  workflowOrganizationBulkRequestSchema,
  workflowOrganizationBulkResponseSchema,
  workflowOrganizationProjectionResponseSchema,
  workflowTagCreateResponseSchema,
} from '@pertexo/contracts';
import { installOrganizationObservations } from './workflow-organization/observations';

import { expect } from '@playwright/test';

import { test } from './support/browser-fixture';

import {
  createEditorWorkspace,
  registerEditorUser,
} from './support/ordinary-editor-session';

import { qualifyExtended } from './workflow-organization/qualification';
import {
  choose,
  cleanupTag,
  closeFilters,
  command,
  createWorkflow,
  favorite,
  folderAction,
  openFilters,
  openTags,
  organize,
  ownedRole,
  row,
  shelf,
} from './workflow-organization/fixture';

installOrganizationObservations();

test('ordinary owner persists shared organization, exact recovery and private discovery filters', async ({
  page,
  request,
  browser,
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
  await phase('folders');
  await shelf(page)
    .getByRole('button', { name: 'New folder', exact: true })
    .click();
  let dialog = page.getByRole('dialog', { name: 'New folder', exact: true });
  await dialog.getByLabel('Name', { exact: true }).fill('Operations');
  const parentReply = await command({
    page,
    button: dialog.getByRole('button', { name: 'Create folder', exact: true }),
    suffix: '/workflow-folders',
    status: 201,
  });
  const parent = workflowFolderCreateResponseSchema.parse(
    await parentReply.json(),
  ).folder;
  await shelf(page)
    .getByRole('button', { name: /^Operations/u })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Operations', level: 2 }),
  ).toBeVisible();
  await shelf(page)
    .getByRole('button', { name: 'New folder', exact: true })
    .click();
  dialog = page.getByRole('dialog', { name: 'New folder', exact: true });
  await dialog.getByLabel('Name', { exact: true }).fill('Child');
  const childReply = await command({
    page,
    button: dialog.getByRole('button', { name: 'Create folder', exact: true }),
    suffix: '/workflow-folders',
    status: 201,
  });
  const child = workflowFolderCreateResponseSchema.parse(
    await childReply.json(),
  ).folder;
  expect(child.parentId).toBe(parent.id);
  expect(child.depth).toBe(2);
  await folderAction(page, 'Operations', 'Delete…');
  const deletion = page.getByRole('dialog', {
    name: 'Delete Operations?',
    exact: true,
  });
  await command({
    page,
    button: deletion.getByRole('button', {
      name: 'Delete folder',
      exact: true,
    }),
    suffix: '/delete',
    status: 409,
  });
  await expect(
    deletion.getByText(
      'Move the workflows and child folders out before deleting this folder.',
    ),
  ).toBeVisible();
  await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
  await folderAction(page, 'Child', 'Rename…');
  dialog = page.getByRole('dialog', { name: 'Rename Child', exact: true });
  await dialog.getByLabel('Name', { exact: true }).fill('Delivery');
  await command({
    page,
    button: dialog.getByRole('button', { name: 'Save name', exact: true }),
    suffix: '/rename',
  });
  await folderAction(page, 'Delivery', 'Move to…');
  dialog = page.getByRole('dialog', { name: 'Move Delivery', exact: true });
  await choose(
    page,
    dialog.getByRole('combobox', { name: 'Move to' }),
    'Top level',
  );
  await command({
    page,
    button: dialog.getByRole('button', { name: 'Move folder', exact: true }),
    suffix: '/move',
  });
  await page
    .getByRole('navigation', { name: 'Folder path' })
    .getByRole('button', { name: 'All workflows', exact: true })
    .click();
  await phase('folder-sharing');
  await folderAction(page, 'Delivery', 'Share…');
  let share = page.getByRole('dialog', { name: 'Share Delivery', exact: true });
  await share.getByText('Only people you choose', { exact: true }).click();
  await expect(share.getByText('Workspace owners and admins')).toBeVisible();
  await command({
    page,
    button: share.getByRole('button', { name: 'Save', exact: true }),
    suffix: '/sharing',
  });
  await page.reload();
  await expect(
    shelf(page).getByRole('img', { name: 'Only chosen people' }),
  ).toBeVisible();
  await folderAction(page, 'Delivery', 'Share…');
  share = page.getByRole('dialog', { name: 'Share Delivery', exact: true });
  await expect(
    share.getByRole('radio', { name: /Only people you choose/u }),
  ).toBeChecked();
  await share.getByText('Everyone in this workspace', { exact: true }).click();
  await command({
    page,
    button: share.getByRole('button', { name: 'Save', exact: true }),
    suffix: '/sharing',
  });
  await openTags(page);
  const tags = page.getByRole('dialog', { name: 'Tags', exact: true });
  await tags.getByLabel('New tag', { exact: true }).fill('ops');
  await phase('tags');
  const tagReply = await command({
    page,
    button: tags.getByRole('button', { name: 'Add tag', exact: true }),
    suffix: '/workflow-tags',
    status: 201,
  });
  const tag = workflowTagCreateResponseSchema.parse(await tagReply.json()).tag;
  await tags.getByRole('button', { name: 'Done', exact: true }).click();

  await phase('placement');
  await organize(page, alphaName, 'move', 'Delivery');
  await organize(page, alphaName, 'tags', 'ops');
  await favorite(page, alphaName);
  await page.getByRole('searchbox', { name: 'Search workflows' }).fill('Alpha');
  await phase('filters');
  await expect(page).toHaveURL(
    (url) => url.searchParams.get('query') === 'Alpha',
  );
  await openFilters(page);
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
  await closeFilters(page);
  await row(page, alphaName)
    .getByRole('link', { name: alphaName, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${alpha}$`, 'u'));
  await page.goBack();
  await expect(page).toHaveURL(filtered.toString());
  await expect(row(page, alphaName)).toBeVisible();
  await openFilters(page);
  await page
    .getByRole('button', { name: 'Clear filters', exact: true })
    .click();
  await closeFilters(page);
  await organize(page, alphaName, 'move', 'Unfiled / top level');
  await phase('unfile');
  await openFilters(page);
  await choose(
    page,
    page.getByRole('combobox', { name: 'Filter by folder' }),
    'Unfiled',
  );
  await expect(row(page, alphaName)).toBeVisible();
  await expect(row(page, betaName)).toBeVisible();
  expect(new URL(page.url()).searchParams.get('folderId')).toBe('root');
  await closeFilters(page);

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
  const replay = await command({
    page,
    button: bulk.getByRole('button', { name: 'Retry original request' }),
    suffix: '/bulk',
  });
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
  await openFilters(page);
  await page
    .getByRole('button', { name: 'Clear filters', exact: true })
    .click();
  await closeFilters(page);

  await phase('cleanup');
  await cleanupTag(page, alphaName);
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
  await qualifyExtended({
    browser,
    page,
    request,
    mailOrigin,
    workspaceId,
    alpha,
    beta,
    folderId: child.id,
    phase,
    role: ownedRole(),
  });
});
