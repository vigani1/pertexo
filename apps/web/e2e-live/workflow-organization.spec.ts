import type { DelegatedRole } from '@pertexo/workflow-model';
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
} from '@pertexo/contracts';
import { test } from './support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from './support/ordinary-editor-session';

let lastIdentityStatus = 0;
// Only a fixed action category and control readiness leave the private journey.
let failedControl: {
  action: 'favorite' | 'invitation' | 'other';
  matches: number;
  enabled: boolean | null;
} | null = null;
test.beforeEach(({ page }) => {
  lastIdentityStatus = 0;
  failedControl = null;
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
        control: failedControl,
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
async function command({
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
    failedControl = {
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
function ownedRole() {
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
async function openFilters(page: Page) {
  await page.getByRole('button', { name: /^Filters/u }).click();
  await expect(
    page.getByRole('heading', { name: 'Filter workflows' }),
  ).toBeVisible();
}
async function closeFilters(page: Page) {
  await page.getByRole('button', { name: /^Filters/u }).press('Escape');
}
async function openRowMenu(page: Page, name: string) {
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
async function openTags(page: Page) {
  await openFilters(page);
  await page.getByRole('button', { name: 'Manage tags…', exact: true }).click();
}
function shelf(page: Page) {
  return page.getByRole('region', { name: 'Folders', exact: true });
}
async function folderAction(
  page: Page,
  folder: string,
  action: 'Rename…' | 'Move to…' | 'Share…' | 'Delete…',
) {
  await shelf(page)
    .getByRole('button', { name: `Actions for ${folder}`, exact: true })
    .click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
async function organize(
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
async function cleanupTag(page: Page, workflowName: string) {
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
async function invitedActor(input: {
  browser: Browser;
  owner: Page;
  request: APIRequestContext;
  mailOrigin: string;
  workspaceId: string;
  role: DelegatedRole;
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
    const response = await command({
      page: input.owner,
      button: sheet.getByRole('button', {
        name: 'Send invitation',
        exact: true,
      }),
      suffix: '/invitations',
      status: 202,
    });
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
