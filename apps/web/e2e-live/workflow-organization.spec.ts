import {
  expect,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import {
  workspaceInvitationCommandResponseSchema,
  accessibleWorkspacesResponseSchema,
  workflowOrganizationProjectionResponseSchema,
  workflowOrganizationBulkRequestSchema,
  workflowOrganizationBulkResponseSchema,
  workflowFolderCreateResponseSchema,
  workflowTagCreateResponseSchema,
  workflowSummaryResponseSchema,
} from '@pertexo/contracts';
import { test } from './support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from './support/ordinary-editor-session';

let lastIdentityStatus = 0;
test.beforeEach(({ page }) => {
  lastIdentityStatus = 0;
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.includes('/auth/'))
      lastIdentityStatus = response.status();
  });
});
test.afterEach(async ({ request, page }, info) => {
  if (process.env.PERTEXO_LIVE_MAIL_ORIGIN !== undefined) {
    const result = await request.post(
      `${process.env.PERTEXO_LIVE_MAIL_ORIGIN}/organization-test-result`,
      {
        data: {
          case:
            info.title ===
            'ordinary owner persists shared organization, exact recovery and private discovery filters'
              ? 'owner'
              : info.title ===
                  'default-off release build preserves ordinary workflows without organization reads or controls'
                ? 'default-off'
                : 'unknown',
          status: info.status === 'passed' ? 'passed' : 'failed',
        },
      },
    );
    expect(result.status()).toBe(204);
  }
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
    {
      data: {
        line,
        identityStatus: lastIdentityStatus,
        identityStage: [
          '/sign-up',
          '/login',
          '/verify-email',
          '/workspaces',
        ].includes(new URL(page.url()).pathname)
          ? new URL(page.url()).pathname
          : 'other',
      },
    },
  );
  if (/^\/w\/[0-9a-f-]+\/workflows$/u.test(new URL(page.url()).pathname))
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
  method = 'POST',
) {
  const replied = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith(suffix) &&
      response.request().method() === method,
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

async function projection(page: Page, workspaceId: string, workflowId: string) {
  const response = await page.request.get(
    `/v1/workspaces/${workspaceId}/workflows/${workflowId}?include=organization`,
  );
  expect(response.status()).toBe(200);
  return workflowOrganizationProjectionResponseSchema.parse(
    await response.json(),
  );
}
async function favorite(page: Page, name: string) {
  await command(
    page,
    row(page, name).getByRole('button', {
      name: `Add favorite for ${name}`,
      exact: true,
    }),
    '/favorite',
    200,
    'PUT',
  );
}
async function lifecycle(
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
  await command(
    page,
    dialog.getByRole('button', {
      name: action === 'archive' ? 'Archive' : 'Restore',
      exact: true,
    }),
    `/${action}`,
    202,
  );
  await expect(dialog).not.toBeVisible();
}
async function cleanupTag(page: Page, workflowName: string) {
  await page
    .getByRole('button', { name: 'Manage folders and tags…', exact: true })
    .click();
  const manager = page.getByRole('dialog', {
    name: 'Manage workflow organization',
    exact: true,
  });
  await manager
    .getByRole('button', { name: 'Edit tag ops', exact: true })
    .click();
  await manager
    .getByRole('button', { name: 'Review tag assignments', exact: true })
    .click();
  await manager
    .getByRole('checkbox', {
      name: `Select ${workflowName}`,
      exact: true,
    })
    .check();
  await command(
    page,
    manager.getByRole('button', {
      name: 'Detach tag from 1 selected workflows',
      exact: true,
    }),
    '/cleanup/detach',
  );
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
  await manager
    .getByRole('button', { name: 'Close manager', exact: true })
    .click();
}
async function invitedActor(input: {
  browser: Browser;
  owner: Page;
  request: APIRequestContext;
  mailOrigin: string;
  workspaceId: string;
  role: 'viewer' | 'builder' | 'admin';
}) {
  const context = await input.browser.newContext({
    baseURL: new URL(input.owner.url()).origin,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const email = await registerEditorUser(
      page,
      input.request,
      input.mailOrigin,
      `Organization ${input.role}`,
    );
    await input.owner.goto(`/w/${input.workspaceId}/team`);
    await input.owner
      .getByRole('button', { name: 'Invite people', exact: true })
      .click();
    const sheet = input.owner.getByRole('dialog', {
      name: 'Invite people',
      exact: true,
    });
    await sheet.getByLabel('Email addresses', { exact: true }).fill(email);
    await sheet.getByLabel('Email addresses', { exact: true }).press('Enter');
    const role = sheet.getByRole('combobox', { name: 'Role', exact: true });
    await role.focus();
    await input.owner.keyboard.press('ArrowDown');
    await input.owner
      .getByRole('option', {
        name: new RegExp(
          `^${input.role[0]?.toUpperCase() ?? ''}${input.role.slice(1)} `,
          'u',
        ),
      })
      .click();
    const response = await command(
      input.owner,
      sheet.getByRole('button', { name: 'Send invitation', exact: true }),
      '/invitations',
      202,
    );
    const invitation = workspaceInvitationCommandResponseSchema.parse(
      await response.json(),
    ).invitation;
    const delivered = await input.request.post(
      `${input.mailOrigin}/invitation-delivery`,
      { data: { workspaceId: input.workspaceId, invitationId: invitation.id } },
    );
    expect(delivered.status()).toBe(200);
    const value: unknown = await delivered.json();
    if (
      typeof value !== 'object' ||
      value === null ||
      !('path' in value) ||
      typeof value.path !== 'string'
    )
      throw new Error('Delivered invitation navigation unavailable');
    try {
      await page.goto(value.path);
    } catch {
      throw new Error(
        'Delivered invitation navigation failed; sensitive details omitted',
      );
    }
    const invitationAction = page.getByRole('button', {
      name: /^(Accept and open workspace|Sign in to accept)$/u,
    });
    await expect(invitationAction).toBeVisible();
    // Prove the account through ordinary sign-in AFTER this bound invitation
    // exists; a pre-invitation session is not treated as acceptance evidence.
    await page.goto('/logout?returnTo=%2Finvitations%2Faccept');
    await expect(page).toHaveURL((url) => url.pathname === '/login');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page
      .getByLabel('Password', { exact: true })
      .fill('a long enough integration password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL('/invitations/accept');
    await page
      .getByRole('button', { name: 'Accept and open workspace', exact: true })
      .click();
    await expect(page).toHaveURL(`/w/${input.workspaceId}`);
    const workspaces = await page.request.get('/v1/workspaces');
    expect(workspaces.status()).toBe(200);
    expect(
      accessibleWorkspacesResponseSchema
        .parse(await workspaces.json())
        .items.find((item) => item.id === input.workspaceId)?.role,
    ).toBe(input.role);
    await page.goto(`/w/${input.workspaceId}/workflows`);
    return { page, close: () => context.close() };
  } catch (cause) {
    await context.close();
    throw cause;
  }
}

async function qualifyExtended(input: {
  browser: Browser;
  page: Page;
  request: APIRequestContext;
  mailOrigin: string;
  workspaceId: string;
  alpha: string;
  beta: string;
  folderId: string;
  phase: (value: string) => Promise<void>;
  role: 'viewer' | 'builder' | 'admin';
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
    await command(
      page,
      dialog.getByRole('button', {
        name: 'Move selected workflows',
        exact: true,
      }),
      '/bulk',
    );
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
  ).toBeDisabled();
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
        await expect(
          actor.page.getByRole('button', {
            name: 'Manage folders and tags…',
            exact: true,
          }),
        ).toHaveCount(0);
        await expect(
          row(actor.page, alphaName).getByRole('button', {
            name: 'Organize…',
            exact: true,
          }),
        ).toHaveCount(0);
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
        await actor.page
          .getByRole('button', { name: 'My favorites', exact: true })
          .click();
        await expect(row(actor.page, betaName)).toBeVisible();
        await expect(row(actor.page, alphaName)).toHaveCount(0);
        await actor.page.setViewportSize({ width: 390, height: 844 });
        await actor.page.screenshot({
          path: '/tmp/pertexo-workflow-organization-viewer-mobile.png',
          fullPage: true,
        });
      } else if (role === 'builder') {
        await expect(
          actor.page.getByRole('button', {
            name: 'Manage folders and tags…',
            exact: true,
          }),
        ).toHaveCount(0);
        await organize(actor.page, alphaName, 'move', 'Delivery');
        expect(
          (await projection(page, workspaceId, alpha)).organization.folderId,
        ).toBe(input.folderId);
        await page.goto(listPath);
        await lifecycle(page, betaName, 'archive');
        await actor.page.goto(`${listPath}?view=archived`);
        await expect(row(actor.page, betaName)).toBeVisible();
        await expect(
          row(actor.page, betaName).getByRole('button', {
            name: 'Organize…',
            exact: true,
          }),
        ).toHaveCount(0);
      } else {
        await expect(
          actor.page.getByRole('button', {
            name: 'Manage folders and tags…',
            exact: true,
          }),
        ).toBeVisible();
        await actor.page.goto(`${listPath}?view=archived`);
        await expect(row(actor.page, betaName)).toBeVisible();
        await organize(actor.page, betaName, 'move', 'Delivery');
        expect(
          (await projection(page, workspaceId, beta)).organization.folderId,
        ).toBe(input.folderId);
        await row(actor.page, betaName)
          .getByRole('button', { name: 'Organize…', exact: true })
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
    page
      .getByRole('dialog', { name: 'Delete Operations?', exact: true })
      .getByRole('button', { name: 'Confirm delete folder' }),
    '/delete',
    409,
  );
  await expect(
    page
      .getByRole('dialog', { name: 'Delete Operations?', exact: true })
      .getByText(
        'Move the workflows and child folders out before deleting this folder.',
      ),
  ).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Delete Operations?', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
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
  await favorite(page, alphaName);
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
    role:
      process.env.PERTEXO_ORGANIZATION_ROLE === 'viewer'
        ? 'viewer'
        : process.env.PERTEXO_ORGANIZATION_ROLE === 'builder'
          ? 'builder'
          : process.env.PERTEXO_ORGANIZATION_ROLE === 'admin'
            ? 'admin'
            : (() => {
                throw new Error('Explicit owned role case required');
              })(),
  });
});

test('default-off release build preserves ordinary workflows without organization reads or controls', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (
    mailOrigin === undefined ||
    process.env.PERTEXO_ORGANIZATION_BROWSER_DEFAULT_OFF !== 'true'
  )
    throw new Error('Explicit owned default-off production build required');
  const phase = async (value: string) => {
    const result = await request.post(`${mailOrigin}/organization-phase`, {
      data: { phase: value },
    });
    expect(result.status()).toBe(204);
  };
  await phase('default-off');
  await registerEditorUser(
    page,
    request,
    mailOrigin,
    'Organization default-off owner',
  );
  const workspaceId = await createEditorWorkspace(
    page,
    'Default-off qualification',
  );
  let metadataReads = 0;
  page.on('request', (sent) => {
    const url = new URL(sent.url());
    if (
      sent.method() === 'GET' &&
      (url.pathname.includes('/workflow-folders') ||
        url.pathname.includes('/workflow-tags') ||
        url.searchParams.get('include') === 'organization')
    )
      metadataReads++;
  });
  const name = 'Default-off workflow';
  const workflowId = await createWorkflow(page, workspaceId, name, phase);
  // Populate through the ordinary authenticated public API, not storage or
  // cookie seeding. These explicit invariant requests are not page UI reads.
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === 'pertexo_csrf',
  );
  if (cookie === undefined)
    throw new Error('Ordinary session CSRF unavailable');
  const write = (path: string, data: unknown) =>
    page.request.post(`/v1/workspaces/${workspaceId}/${path}`, {
      headers: {
        'x-csrf-token': decodeURIComponent(cookie.value),
        'Idempotency-Key': crypto.randomUUID(),
      },
      data,
    });
  const folderResponse = await write('workflow-folders', {
    name: 'Retained while disabled',
    parentId: null,
  });
  expect(folderResponse.status()).toBe(201);
  const folderId = workflowFolderCreateResponseSchema.parse(
    await folderResponse.json(),
  ).folder.id;
  const tagResponse = await write('workflow-tags', { key: 'off-proof' });
  expect(tagResponse.status()).toBe(201);
  const tagId = workflowTagCreateResponseSchema.parse(await tagResponse.json())
    .tag.id;
  let state = await projection(page, workspaceId, workflowId);
  const placement = await write(`workflows/${workflowId}/folder`, {
    folderId,
    expectedOrganizationRevision: state.organization.organizationRevision,
  });
  expect(placement.status()).toBe(200);
  state = await projection(page, workspaceId, workflowId);
  const tags = await write(`workflows/${workflowId}/tags`, {
    tagIds: [tagId],
    expectedOrganizationRevision: state.organization.organizationRevision,
  });
  expect(tags.status()).toBe(200);
  const favorite = await page.request.put(
    `/v1/workspaces/${workspaceId}/workflows/${workflowId}/favorite`,
    {
      headers: { 'x-csrf-token': decodeURIComponent(cookie.value) },
      data: { favorite: true },
    },
  );
  expect(favorite.status()).toBe(200);
  await page.goto(`/w/${workspaceId}/workflows`);
  await expect(row(page, name)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Manage folders and tags…', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Name contains', { exact: true })).toHaveCount(
    0,
  );
  await expect(
    row(page, name).getByRole('button', { name: 'Organize…', exact: true }),
  ).toHaveCount(0);
  await expect(
    row(page, name).getByRole('button', {
      name: `Add favorite for ${name}`,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    row(page, name).getByRole('checkbox', {
      name: `Select ${name}`,
      exact: true,
    }),
  ).toHaveCount(0);
  const summary = await page.request.get(
    `/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
  );
  expect(summary.status()).toBe(200);
  expect(
    workflowSummaryResponseSchema.parse(await summary.json()).workflow.name,
  ).toBe(name);
  expect(metadataReads).toBe(0);
  const retained = await projection(page, workspaceId, workflowId);
  expect(retained.organization.folderId).toBe(folderId);
  expect(retained.organization.tags.map((tag) => tag.id)).toEqual([tagId]);
  expect(retained.organization.isFavorite).toBe(true);
  const receipt = await request.post(`${mailOrigin}/organization-default-off`, {
    data: {
      workspaceId,
      workflowId,
      folderId,
      tagId,
      metadataRetained: true,
      metadataReads,
      organizationControls: false,
    },
  });
  expect(receipt.status()).toBe(204);
  await page.screenshot({
    path: '/tmp/pertexo-workflow-organization-default-off.png',
    fullPage: true,
  });
});
