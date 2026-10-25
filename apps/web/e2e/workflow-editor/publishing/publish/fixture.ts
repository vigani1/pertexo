import { expect, type Page } from '../../../support/fixtures';
import {
  currentEtag,
  runSummary,
  workflowId,
  workflowSummary,
  workspaceId,
  type Graph,
  type RemoteDraft,
} from '../../support';
export const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const previewId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const disclosure = {
  sideEffectClass: 'safe',
  mayContactProvider: false,
  mayCauseExternalSideEffect: false,
  dryRun: 'not_supported',
};

export async function installNodeTestRoute(page: Page, remote: RemoteDraft) {
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/nodes/*/test`,
    async (route) => {
      const body = route.request().postDataJSON() as {
        mode: 'validate' | 'test_execute';
        expectedRevision: number;
      };
      expect(body.expectedRevision).toBe(remote.revision);
      const nodeId = firstNodeId(remote.graph);
      if (body.mode === 'validate') {
        await route.fulfill({
          json: {
            mode: 'validate',
            valid: true,
            revision: remote.revision,
            nodeId,
            issues: [],
            disclosure,
          },
        });
        return;
      }
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      await route.fulfill({
        status: 202,
        json: {
          mode: 'test_execute',
          replayed: false,
          preview: previewSummary(nodeId, remote.revision),
        },
      });
    },
  );
}

export async function installPublishRoutes(page: Page, remote: RemoteDraft) {
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/publish`,
    async (route) => {
      expect(route.request().headers()['if-match']).toBe(currentEtag(remote));
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      await page.route(
        `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
        (summaryRoute) =>
          summaryRoute.fulfill({
            json: workflowSummary('Customer onboarding', versionId),
          }),
      );
      return route.fulfill({
        json: { version: version(remote.graph, 'b'), reused: false },
      });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
    (route) => {
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      return route.fulfill({
        json: { run: runSummary(runId, versionId, 'queued'), replayed: false },
      });
    },
  );
  await page.route(`**/v1/workspaces/${workspaceId}/runs/${runId}`, (route) =>
    route.fulfill({
      json: { run: runSummary(runId, versionId, 'succeeded'), nodes: [] },
    }),
  );
  await routeVersions(page, () => remote.graph, 'b');
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${runId}/events`,
    (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: `id: 1\nevent: run.succeeded\ndata: ${JSON.stringify({
          sequence: 1,
          type: 'run.succeeded',
          createdAt: '2026-09-14T10:03:00.000Z',
          payload: {},
        })}\n\n`,
      }),
  );
}

export async function routeVersions(
  page: Page,
  graph: () => Graph,
  checksum: string,
) {
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?**`,
    (route) =>
      route.fulfill({
        json: { items: [version(graph(), checksum)], nextCursor: null },
      }),
  );
}

function version(graph: Graph, checksum: string) {
  return {
    id: versionId,
    workflowId,
    versionNumber: 1,
    graph,
    checksum: `wf:sha256:${checksum.repeat(64)}`,
    publishedAt: '2026-09-14T10:02:00.000Z',
  };
}

function firstNodeId(graph: Graph): string {
  const node = graph.nodes[0];
  return typeof node === 'object' && node !== null
    ? String(Reflect.get(node, 'id'))
    : 'missing';
}

function previewSummary(nodeId: string, revision: number) {
  return {
    id: previewId,
    workspaceId,
    workflowId,
    draftRevision: revision,
    nodeId,
    status: 'succeeded',
    disclosure,
    output: { kind: 'inline', value: { accepted: true } },
    safeErrorCode: null,
    createdAt: '2026-09-14T10:01:00.000Z',
    startedAt: '2026-09-14T10:01:01.000Z',
    completedAt: '2026-09-14T10:01:02.000Z',
    expiresAt: '2026-09-14T11:01:02.000Z',
  };
}
