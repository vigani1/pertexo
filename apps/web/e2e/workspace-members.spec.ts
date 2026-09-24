import { expect, test, type Page } from '@playwright/test';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const firstMemberId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const secondMemberId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const timestamp = '2026-09-15T10:00:00.000Z';

function member(userIdValue: string, displayName: string, role: string) {
  return {
    userId: userIdValue,
    email: `${userIdValue.slice(0, 8)}@example.test`,
    displayName,
    role,
    roleRevision: 1,
    membershipStatus: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function installRoutes(page: Page) {
  await page.route('**/v1/users/me', (route) =>
    route.fulfill({
      json: {
        id: userId,
        email: 'operator@example.test',
        displayName: 'Pertexo Operator',
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
            revision: 1,
            role: 'viewer',
            capabilities: ['workspace:read', 'member:read'],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/members?**`, (route) => {
    const after = new URL(route.request().url()).searchParams.get('after');
    return route.fulfill({
      json:
        after === null
          ? {
              items: [member(firstMemberId, 'Ada Operator', 'owner')],
              nextCursor: 'next-page',
            }
          : {
              items: [member(secondMemberId, 'Lin Builder', 'viewer')],
              nextCursor: null,
            },
    });
  });
  await page.route(`**/v1/workspaces/${workspaceId}/invitations?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  const release = {
    epoch: 1,
    fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
  };
  await page.route('**/v1/node-definitions', (route) =>
    route.fulfill({ json: { schemaVersion: 1, release, items: [] } }),
  );
  await page.route('**/v1/integrations', (route) =>
    route.fulfill({ json: { schemaVersion: 1, release, items: [] } }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
}

test('opens the authorized member directory and paginates it', async ({
  page,
}) => {
  await installRoutes(page);
  await page.goto(`/w/${workspaceId}/workflows`);
  await page.getByRole('link', { name: 'Workspace settings' }).click();

  await expect(page).toHaveURL(`/w/${workspaceId}/settings/members`);
  await expect(
    page.getByRole('link', { name: 'Workspace settings' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Ada Operator')).toBeVisible();
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByText('Lin Builder')).toBeVisible();
});

test('keeps the member directory reachable and bounded on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRoutes(page);
  await page.goto(`/w/${workspaceId}/workflows`);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Workspace settings' }).click();

  await expect(page).toHaveURL(`/w/${workspaceId}/settings/members`);
  await expect(
    page.getByRole('button', { name: 'Open navigation' }),
  ).toBeVisible();
  await expect(page.getByText('Ada Operator')).toBeVisible();
  const tableRegion = page.getByRole('region', {
    name: 'Scrollable data table',
  });
  await expect(
    page.getByText('Scroll horizontally to view all columns and actions.'),
  ).toBeVisible();
  await tableRegion.focus();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => tableRegion.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('confirms a role change and sends its exact revision and command key', async ({
  page,
}) => {
  const csrfToken = 'member-role-browser-csrf-token-123456';
  let authoritativeRole = 'viewer';
  let authoritativeRevision = 1;
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
  await installRoutes(page);
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: workspaceId,
            name: 'Control Operations',
            slug: 'control-operations',
            status: 'active',
            revision: 1,
            role: 'owner',
            capabilities: ['workspace:read', 'member:read', 'member:manage'],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/members/${firstMemberId}/role`,
    async (route) => {
      const request = route.request();
      expect(request.headers()['x-csrf-token']).toBe(csrfToken);
      expect(request.headers()['idempotency-key']).toBeTruthy();
      expect(request.postDataJSON()).toEqual({
        role: 'operator',
        expectedRoleRevision: 1,
      });
      authoritativeRole = 'operator';
      authoritativeRevision = 2;
      await route.fulfill({
        json: {
          userId: firstMemberId,
          role: 'operator',
          roleRevision: 2,
          changed: true,
          replayed: false,
        },
      });
    },
  );
  await page.route(`**/v1/workspaces/${workspaceId}/members?**`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            ...member(firstMemberId, 'Ada Operator', authoritativeRole),
            roleRevision: authoritativeRevision,
          },
        ],
        nextCursor: null,
      },
    }),
  );

  await page.goto(`/w/${workspaceId}/settings/members`);
  await page.getByRole('button', { name: 'Change role' }).click();
  await expect(page.getByText(/must sign in again/u)).toBeVisible();
  await page.getByLabel('New role').selectOption('operator');
  await page.getByRole('button', { name: 'Change role' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const memberRow = page.getByRole('row').filter({ hasText: 'Ada Operator' });
  await expect(memberRow.getByText('operator', { exact: true })).toBeVisible();
});

test('creates an invitation and refreshes the authoritative pending list', async ({
  page,
}) => {
  const csrfToken = 'invitation-browser-csrf-token-123456';
  const invitationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  let invitations: object[] = [];
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
  await installRoutes(page);
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: workspaceId,
            name: 'Control Operations',
            slug: 'control-operations',
            status: 'active',
            revision: 1,
            role: 'owner',
            capabilities: ['workspace:read', 'member:read', 'member:manage'],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/invitations**`,
    async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({ json: { items: invitations, nextCursor: null } });
        return;
      }
      expect(request.headers()['x-csrf-token']).toBe(csrfToken);
      expect(request.headers()['idempotency-key']).toBeTruthy();
      expect(request.postDataJSON()).toEqual({
        email: 'new.builder@example.test',
        role: 'builder',
      });
      const invitation = {
        id: invitationId,
        email: 'new.builder@example.test',
        role: 'builder',
        status: 'pending',
        revision: 1,
        deliveryStatus: 'queued',
        expiresAt: '2026-09-22T10:00:00.000Z',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      invitations = [invitation];
      await route.fulfill({
        status: 202,
        json: { invitation, replayed: false },
      });
    },
  );

  await page.goto(`/w/${workspaceId}/settings/members`);
  await page.getByRole('button', { name: 'Invite member' }).click();
  await page.getByLabel('Recipient email').fill('new.builder@example.test');
  await page.getByLabel('Workspace role').selectOption('builder');
  await page.getByRole('button', { name: 'Send invitation' }).click();

  const row = page
    .getByRole('row')
    .filter({ hasText: 'new.builder@example.test' });
  await expect(row.getByText('builder', { exact: true })).toBeVisible();
  await expect(row.getByText('queued', { exact: true })).toBeVisible();
});
