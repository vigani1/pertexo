import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../../test/support/fixtures/identity';
import { expect, type Page } from '../../support/fixtures';
import {
  routeEmptyWorkflowOrganization,
  workflowListBody,
} from '../../workflows/list-support';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const csrfToken =
  'csrf-token-for-browser-tests-123456789012345678901234';

export const user = createUserFixture({
  id: userId,
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
});

export const workspace = createWorkspaceFixture({
  id: workspaceId,
  capabilities: [
    'workspace:read',
    'workspace:manage',
    'workflow:read',
    'workflow:create',
    'connection:read',
  ],
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
});

export function unauthenticatedProblem() {
  return JSON.stringify({
    type: 'https://pertexo.test/problems/auth.unauthenticated',
    title: 'Authentication required',
    status: 401,
    code: 'auth.unauthenticated',
    requestId: 'browser-request-1234',
  });
}

export async function mockIdentity(
  page: Page,
  options: Readonly<{
    authenticated: boolean;
    user?: unknown;
    workspaces?: unknown[];
    workflows?: unknown[];
  }>,
) {
  let authenticated = options.authenticated;
  const currentUser = options.user ?? user;
  const workspaces = options.workspaces ?? [workspace];
  const workflows = options.workflows ?? [];

  await page.route('**/v1/users/me', async (route) => {
    if (authenticated) {
      await route.fulfill({ json: currentUser });
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: unauthenticatedProblem(),
    });
  });
  await page.route('**/v1/workspaces?**', async (route) => {
    await route.fulfill({ json: { items: workspaces, nextCursor: null } });
  });
  await page.route('**/v1/auth/capabilities', async (route) => {
    await route.fulfill({
      json: {
        password: {
          enabled: true,
          minimumLength: 12,
          verificationRequired: true,
        },
        socialProviders: [],
        signUp: 'open',
      },
    });
  });
  await page.route('**/v1/auth/sign-in/email', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toMatchObject({
      email: 'operator@example.test',
      password: 'correct horse battery staple',
    });
    authenticated = true;
    await route.fulfill({
      status: 200,
      headers: {
        'set-cookie': `pertexo_csrf=${csrfToken}; Path=/; SameSite=Lax`,
      },
      json: { redirect: false, token: null, user: currentUser },
    });
  });
  await page.route('**/v1/auth/logout', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-csrf-token']).toBe(csrfToken);
    authenticated = false;
    await route.fulfill({ status: 204 });
  });
  await routeEmptyWorkflowOrganization(page, workspaceId);
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows?**`,
    async (route) => {
      await route.fulfill({
        json: workflowListBody(route.request().url(), workflows),
      });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows`,
    async (route) => {
      const request = route.request();
      expect(request.method()).toBe('POST');
      expect(request.headers()['x-csrf-token']).toBe(csrfToken);
      expect(request.headers()['idempotency-key']).toBeTruthy();
      const body = request.postDataJSON() as { name: string };
      const workflow = {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        workspaceId,
        name: body.name,
        nameRevision: 1,
        lifecycleStatus: 'active',
        lifecycleRevision: 1,
        activationStatus: 'inactive',
        webhookSetupRequired: false,
        publishedVersionId: null,
        createdAt: '2026-09-14T10:00:00.000Z',
        updatedAt: '2026-09-14T10:00:00.000Z',
      };
      workflows.push(workflow);
      await route.fulfill({
        status: 201,
        headers: {
          'content-type': 'application/json',
          etag: `"draft.${'a'.repeat(43)}"`,
        },
        body: JSON.stringify({
          workflow,
          draft: {
            workflowId: workflow.id,
            revision: 1,
            graph: { nodes: [], edges: [], settings: {} },
            compatibility: {
              compatible: true,
              fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
              issues: [],
            },
            updatedAt: workflow.updatedAt,
          },
        }),
      });
    },
  );
  await page.route('**/v1/node-definitions', async (route) => {
    await route.fulfill({ json: { items: [] } });
  });
  await page.route('**/v1/integrations', async (route) => {
    await route.fulfill({ json: { items: [] } });
  });
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections?**`,
    async (route) => {
      await route.fulfill({ json: { items: [], nextCursor: null } });
    },
  );
}
