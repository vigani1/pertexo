import {
  parseWorkflowGraphDraft,
  portableGraphDigest,
} from '@pertexo/workflow-model';
import { workflowVersionsResponseSchema } from '@pertexo/contracts';
import { expect, test } from '../support/fixtures';
import { workflowListBody } from '../workflows/list-support';
import { mappingGraph } from './graph';
import { routeVersions } from './publishing/publish/fixture';
import {
  installEditorRoutes,
  remoteDraft,
  workspaceId,
  workflowId,
  workflowSummary,
} from './support';

test('serves opt-in graph identities without changing default draft or version replies', async ({
  page,
}) => {
  const graph = mappingGraph();
  await installEditorRoutes(page, remoteDraft(graph));
  await routeVersions(page, () => graph, 'b');
  await page.goto('/login');
  const path = `/v1/workspaces/${workspaceId}/workflows/${workflowId}`;
  const reads = await page.evaluate(async (path) => {
    const read = async (url: string) => {
      const response = await fetch(url);
      return {
        status: response.status,
        etag: response.headers.get('etag'),
        body: response.ok
          ? ((await response.json()) as Record<string, unknown>)
          : null,
      };
    };
    return {
      included: await read(`${path}/draft?include=graphDigest`),
      standard: await read(`${path}/draft`),
      versions: await read(`${path}/versions?include=graphDigest&limit=25`),
      standardVersions: await read(`${path}/versions?limit=25`),
    };
  }, path);
  expect(reads.included.status).toBe(200);
  expect(reads.standard.status).toBe(200);
  const digest = await portableGraphDigest(parseWorkflowGraphDraft(graph));
  expect(reads.included.body?.graphDigest).toBe(digest);
  expect(reads.standard.body).not.toHaveProperty('graphDigest');
  expect(reads.included.etag).toBe(reads.standard.etag);
  expect(
    workflowVersionsResponseSchema.parse(reads.versions.body).items[0]
      ?.graphDigest,
  ).toBe(digest);
  expect(
    workflowVersionsResponseSchema.parse(reads.standardVersions.body).items[0],
  ).not.toHaveProperty('graphDigest');
});

test('serves list summaries only on request, including organized list reads', async ({
  page,
}) => {
  await installEditorRoutes(page, remoteDraft());
  const workflow = workflowSummary('Projection fixture').workflow;
  const listSummary = {
    shape: {
      nodes: [
        {
          id: 'preview',
          definition: { key: 'core.set', version: 1 },
          position: { x: 80, y: 80 },
          label: 'Preview step',
        },
      ],
      edges: [],
    },
    recentRuns: [
      { status: 'succeeded', createdAt: '2026-09-14T10:00:00.000Z' },
    ],
  };
  const emptyWorkflow = {
    ...workflow,
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    name: 'Empty fixture',
  };
  await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
    route.fulfill({
      json: workflowListBody(route.request().url(), [
        { ...workflow, listSummary },
        emptyWorkflow,
      ]),
    }),
  );
  await page.goto('/login');
  const responses = await page.evaluate(
    async (path) =>
      Promise.all(
        [
          '?limit=25',
          '?include=listSummary',
          '?include=organization,listSummary',
        ].map(async (query) => {
          const response = await fetch(path + query);
          return response.json() as Promise<{
            items: Record<string, unknown>[];
          }>;
        }),
      ),
    `/v1/workspaces/${workspaceId}/workflows`,
  );
  expect(responses[0]?.items[0]).toEqual(workflow);
  expect(responses[0]?.items[1]).toEqual(emptyWorkflow);
  expect(responses[1]?.items[1]).toEqual({
    ...emptyWorkflow,
    listSummary: { shape: { nodes: [], edges: [] }, recentRuns: [] },
  });
  expect(responses[1]?.items[0]).toEqual({ ...workflow, listSummary });
  expect(responses[2]?.items[0]).toEqual({
    workflow: { ...workflow, listSummary },
    organization: {
      organizationRevision: 1,
      folderId: null,
      tags: [],
      isFavorite: false,
    },
  });
});
