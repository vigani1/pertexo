import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../../test/support/fixtures/identity';
import type { Page } from '../../support/fixtures';

export const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const firstMemberId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const secondMemberId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const timestamp = '2026-09-15T10:00:00.000Z';

export function member(userIdValue: string, displayName: string, role: string) {
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

export async function installRoutes(page: Page) {
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflow-folders**`,
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/workflow-tags**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route('**/v1/users/me', (route) =>
    route.fulfill({
      json: createUserFixture({
        id: userId,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    }),
  );
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({
      json: {
        items: [
          createWorkspaceFixture({
            id: workspaceId,
            role: 'viewer',
            capabilities: ['workspace:read', 'member:read'],
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
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
    route.fulfill({
      json: { issuanceAvailable: true, items: [], nextCursor: null },
    }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route('**/v1/node-definitions', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/v1/integrations', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
}
