import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../test/support/fixtures/identity';
import { expect, type Page } from '../support/fixtures';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const workflowVersionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const firstRunId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export const secondRunId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export const replayRunId = '11111111-1111-4111-8111-111111111111';

export const csrfToken = 'csrf-token-for-run-replay-tests-123456789012345678';

export const timestamp = '2026-09-15T10:00:00.000Z';

export function run(
  id: string,
  status: 'failed' | 'succeeded' | 'outcome_unknown',
  workflowName = 'Customer onboarding',
) {
  return {
    id,
    workspaceId,
    workflowId,
    workflowVersionId,
    workflowName,
    status,
    triggerType: 'manual',
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    completedAt: '2026-09-15T10:00:02.000Z',
    deadlineAt: null,
    cancelRequestedAt: null,
  };
}

export async function installRoutes(page: Page, workflowName?: string) {
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
            capabilities: [
              'workspace:read',
              'workflow:read',
              'run:read',
              'run:replay',
            ],
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        ],
        nextCursor: null,
      },
    }),
  );
  const workflow = {
    id: workflowId,
    workspaceId,
    name: 'Customer onboarding',
    nameRevision: 1,
    lifecycleStatus: 'active',
    lifecycleRevision: 1,
    activationStatus: 'active',
    webhookSetupRequired: false,
    publishedVersionId: workflowVersionId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
    route.fulfill({ json: { items: [workflow], nextCursor: null } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
    (route) => route.fulfill({ json: { workflow } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/run-statistics?**`,
    (route) =>
      route.fulfill({
        json: {
          asOf: '2026-09-15T10:00:00.000000Z',
          current: { queued: 0, running: 2, waiting: 1 },
          window: {
            duration: '24h',
            createdAtFrom: '2026-09-14T10:00:00.000000Z',
            createdAtBefore: '2026-09-15T10:00:00.000000Z',
            total: 0,
            byStatus: {
              queued: 0,
              running: 0,
              waiting: 0,
              succeeded: 0,
              failed: 0,
              canceled: 0,
              timed_out: 0,
              outcome_unknown: 0,
            },
          },
          workflows: null,
        },
      }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/runs?**`, (route) => {
    const query = new URL(route.request().url()).searchParams;
    const filtered = query.get('status') === 'succeeded';
    const after = query.get('after');
    if (filtered)
      return route.fulfill({
        json: {
          items: [run(firstRunId, 'succeeded', workflowName)],
          nextCursor: null,
        },
      });
    if (after === null)
      return route.fulfill({
        json: {
          items: [run(firstRunId, 'succeeded', workflowName)],
          nextCursor: 'next',
        },
      });
    return route.fulfill({
      json: {
        items: [run(secondRunId, 'failed', workflowName)],
        nextCursor: null,
      },
    });
  });
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
    (route) =>
      route.fulfill({
        json: {
          run: run(firstRunId, 'succeeded', workflowName),
          nodes: [],
        },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${replayRunId}`,
    (route) =>
      route.fulfill({
        json: {
          run: {
            ...run(replayRunId, 'failed'),
            triggerType: 'replay',
          },
          nodes: [],
        },
      }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/runs/*/input`, (route) =>
    route.fulfill({
      json: { input: { kind: 'inline', value: { incident: 'INC-41' } } },
    }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/events`,
    (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: '',
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${replayRunId}/events`,
    (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: '',
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?**`,
    (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: workflowVersionId,
              workflowId,
              versionNumber: 1,
              graph: { nodes: [], edges: [], settings: {} },
              checksum:
                'wf:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              publishedAt: timestamp,
            },
          ],
          nextCursor: null,
        },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/replay`,
    async (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(csrfToken);
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      expect(route.request().postDataJSON()).toEqual({
        workflowVersionId,
        input: { incident: 'INC-42' },
      });
      const { workflowName, ...acceptedRun } = run(replayRunId, 'failed');
      await route.fulfill({
        status: 202,
        json: {
          run: {
            ...acceptedRun,
            triggerType: 'replay',
          },
          replayed: false,
        },
      });
    },
  );
}
