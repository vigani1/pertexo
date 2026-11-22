import {
  AGENT_FIND_ROWS,
  AGENT_STEP,
  CLASSIFY_STEP,
} from '@pertexo/workflow-model';
import { expect, test } from '../support/fixtures';
import { workflowVersionsBody } from '../workflows/read-projections';
import {
  firstRunId,
  installRoutes,
  run,
  timestamp,
  workflowId,
  workflowVersionId,
  workspaceId,
} from './fixture';

test.use({ viewport: { width: 1440, height: 920 } });

test('shows the pinned branch label and groups Agent activity under its full duration', async ({
  page,
}, info) => {
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
  await installRoutes(page);
  const base = `/v1/workspaces/${workspaceId}/runs/${firstRunId}`;
  const nodeId = 'look-up-order';
  const parent = 'look-up-order:0';
  const branchId = 'route-request';
  const at = (seconds: number) =>
    new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();
  const step = (
    id: string,
    invocationKey: string,
    node: string,
    [start, end]: readonly [start: number, end: number],
  ) => ({
    id,
    nodeId: node,
    invocationKey,
    status: 'succeeded',
    currentAttemptNumber: 1,
    startedAt: at(start),
    completedAt: at(end),
    safeErrorCode: null,
    resumeAt: null,
  });
  const classify = step(
    '22222222-2222-4222-8222-222222222222',
    'route-request:0',
    branchId,
    [0, 1],
  );
  const agent = step(
    '33333333-3333-4333-8333-333333333333',
    parent,
    nodeId,
    [9, 9],
  );
  const turn = step(
    '44444444-4444-4444-8444-444444444444',
    'turn:1',
    nodeId,
    [2, 5],
  );
  const tool = step(
    '66666666-6666-4666-8666-666666666666',
    'tool:1',
    nodeId,
    [5, 7],
  );
  const lastTurn = step(
    '55555555-5555-4555-8555-555555555555',
    'turn:2',
    nodeId,
    [7, 9],
  );
  await page.route(`**${base}`, (route) =>
    route.fulfill({
      json: {
        run: { ...run(firstRunId, 'succeeded'), completedAt: at(10) },
        nodes: [classify, turn, tool, agent, lastTurn],
      },
    }),
  );
  await page.route(`**${base}/events`, (route) => {
    const events = [turn, tool, lastTurn].map((row, index) => ({
      sequence: index + 1,
      createdAt: row.startedAt,
      type: 'node.started',
      payload: {
        nodeRunId: row.id,
        nodeId,
        invocationKey: row.invocationKey,
        attemptNumber: 1,
        agentWork: {
          parentInvocationKey: parent,
          turn: row === lastTurn ? 2 : 1,
          ...(row === tool
            ? {
                work: { kind: 'tool_call', ordinal: 1 },
                definition: AGENT_FIND_ROWS,
                alias: 'find_orders',
              }
            : { work: { kind: 'model_turn' }, definition: AGENT_STEP }),
        },
      },
    }));
    return route.fulfill({
      contentType: 'text/event-stream',
      body: events
        .map(
          (event) =>
            `id: ${String(event.sequence)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(''),
    });
  });
  await page.route(`**${base}/node-runs/*/diagnostics?*`, (route) =>
    route.fulfill({ json: { diagnostics: null } }),
  );
  await page.route(`**${base}/node-runs/*/input`, (route) =>
    route.fulfill({ json: { input: { kind: 'none' } } }),
  );
  await page.route(`**${base}/node-runs/*/output`, (route) =>
    route.fulfill({
      json: {
        output: {
          kind: 'inline',
          value: route.request().url().endsWith(`/${classify.id}/output`)
            ? { selectedPort: 'category-01' }
            : { answer: 'Order 17 has shipped.' },
        },
      },
    }),
  );
  const graphNode = (
    id: string,
    definition: typeof AGENT_STEP | typeof CLASSIFY_STEP,
    label: string,
    config: object,
  ) => ({
    id,
    definition,
    label,
    config,
    position: { x: 0, y: 0 },
    configVersion: 1,
    inputMappings: {},
    connectionRefs: {},
  });
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?**`,
    async (route) =>
      route.fulfill({
        json: await workflowVersionsBody(route.request().url(), {
          items: [
            {
              id: workflowVersionId,
              workflowId,
              versionNumber: 1,
              graph: {
                nodes: [
                  graphNode(branchId, CLASSIFY_STEP, 'Route request', {
                    categories: [
                      {
                        id: 'category-01',
                        label: 'Payments',
                        description: 'Questions about a payment',
                      },
                    ],
                  }),
                  graphNode(nodeId, AGENT_STEP, 'Look up order', {}),
                ],
                edges: [],
                settings: {},
              },
              checksum: `wf:sha256:${'a'.repeat(64)}`,
              publishedAt: timestamp,
            },
          ],
          nextCursor: null,
        }),
      }),
  );

  await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
  const timeline = page.getByRole('list', { name: 'Steps in this run' });
  const inspector = page.getByRole('complementary', { name: 'Step details' });
  await timeline.getByRole('button', { name: /^Route request:/u }).click();
  await expect(inspector.getByText('Payments', { exact: true })).toBeVisible();
  await expect(
    inspector.getByText('category-01', { exact: true }),
  ).toBeVisible();
  await screenshots(page, info.outputPath('branch-output'));

  await expect(timeline.getByRole('button')).toHaveText([
    /Route request/u,
    /Look up order.*7s/u,
    /Model turn 1/u,
    /Find rows · find_orders/u,
    /Model turn 2/u,
  ]);
  await timeline
    .getByRole('button', { name: 'Look up order: Succeeded, 7s' })
    .click();
  await expect(inspector.getByText('7s', { exact: true })).toBeVisible();
  await screenshots(page, info.outputPath('agent-duration'));
});

async function screenshots(
  page: import('@playwright/test').Page,
  path: string,
) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      colorScheme,
    );
    await page.screenshot({
      animations: 'disabled',
      path: `${path}-${colorScheme}.png`,
    });
  }
}
