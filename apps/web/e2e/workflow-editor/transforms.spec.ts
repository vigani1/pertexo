import { expect, test } from '@playwright/test';
import { platformBrowserNodeDefinitionCatalog } from '../../../../packages/node-catalog/dist/index.js';
import {
  nodeDefinitionListResponseSchema,
  workflowDraftResponseSchema,
} from '@pertexo/contracts';
import { authorCollectionGraph } from '../../e2e-live/support/authoring/transforms';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  mappingGraph,
  remoteDraft,
  user,
  workflowId,
  workspaceId,
  type RemoteDraft,
} from './support';

const definitions = nodeDefinitionListResponseSchema.parse({
  items: platformBrowserNodeDefinitionCatalog().definitions,
}).items;
const readMockDraft = (remote: RemoteDraft) => () =>
  Promise.resolve(
    workflowDraftResponseSchema.parse({
      workflowId,
      revision: remote.revision,
      graph: remote.graph,
      compatibility: {
        compatible: true,
        fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
        issues: [],
      },
      updatedAt: user.updatedAt,
    }),
  );

test('authors the collection chain with real schemas, words and exact saved values', async ({
  page,
  context,
}) => {
  await addCsrfCookie(context);
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
  const remote = remoteDraft();
  await installEditorRoutes(page, remote, {
    definitions,
    workflowName: 'Invoice preparation',
  });
  await page.goto(editorUrl);
  const authored = await authorCollectionGraph(
    page,
    `/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
    readMockDraft(remote),
  );
  expect(
    authored.graph.nodes.find((node) => node.id === authored.filterId)?.config,
  ).toEqual({ path: '$.paid', operator: 'equals' });
  expect(
    authored.graph.nodes.find((node) => node.id === authored.sortId)?.config,
  ).toEqual({
    path: '$.amount',
    valueType: 'number',
    direction: 'ascending',
    missing: 'last',
  });
  expect(
    authored.graph.nodes.find((node) => node.id === authored.summaryId)?.config,
  ).toEqual({ valuePath: '$.amount', groupBy: '$.currency', missing: 'error' });
  await page.reload();
  await page.getByTestId(`rf__node-${authored.sortId}`).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  await page.getByLabel('Direction', { exact: true }).press('Enter');
  await page
    .getByRole('option', { name: 'Descending', exact: true })
    .press('Enter');
  await expect
    .poll(
      async () =>
        (await readMockDraft(remote)()).graph.nodes.find(
          (node) => node.id === authored.sortId,
        )?.config.direction,
    )
    .toBe('descending');
  if (process.env.PERTEXO_TRANSFORM_SCREENSHOTS !== undefined)
    await page.screenshot({
      path: `${process.env.PERTEXO_TRANSFORM_SCREENSHOTS}/transforms-desktop.png`,
    });
});

for (const editable of [true, false]) {
  test(`keeps expression examples editable only with permission at phone width (${String(editable)})`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 375, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
    const graph = workflowDraftResponseSchema.shape.graph.parse(mappingGraph());
    const remote = remoteDraft({
      ...graph,
      settings: { ...graph.settings },
      nodes: graph.nodes.map((node) =>
        node.id === 'target'
          ? {
              ...node,
              inputMappings: {
                prepared: {
                  kind: 'expression',
                  language: 'jsonata',
                  expression: 'runInput.original',
                },
              },
            }
          : node,
      ),
    });
    await installEditorRoutes(page, remote, {
      definitions,
      ...(editable
        ? {}
        : {
            accessibleWorkspace: {
              id: workspaceId,
              name: 'Control Operations',
              slug: 'control-operations',
              status: 'active',
              revision: 1,
              role: 'viewer',
              capabilities: ['workspace:read', 'workflow:read'],
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
            },
          }),
    });
    await page.goto(editorUrl);
    await page.getByTestId('rf__node-target').click();
    await page
      .getByRole('navigation', { name: 'Editor panels' })
      .getByRole('button', { name: 'Step', exact: true })
      .click();
    await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
    await page.getByRole('button', { name: /^prepared from/u }).click();
    await page.getByText('Expression examples', { exact: true }).press('Enter');
    const choose = page.getByRole('button', {
      name: 'Use trim whitespace',
      exact: true,
    });
    await expect(
      page.getByText('Example result:', { exact: false }).first(),
    ).toBeVisible();
    if (editable) {
      await choose.press('Enter');
      await expect(
        page.getByRole('textbox', { name: 'Expression', exact: true }),
      ).toHaveValue('$trim(runInput.text)');
      await expect
        .poll(
          async () =>
            (await readMockDraft(remote)()).graph.nodes.find(
              (node) => node.id === 'target',
            )?.inputMappings.prepared,
        )
        .toEqual({
          kind: 'expression',
          language: 'jsonata',
          expression: '$trim(runInput.text)',
        });
      await page
        .getByRole('textbox', { name: 'Expression', exact: true })
        .fill('$uppercase(runInput.text)');
      await page.keyboard.press('Tab');
      await expect
        .poll(
          async () =>
            (await readMockDraft(remote)()).graph.nodes.find(
              (node) => node.id === 'target',
            )?.inputMappings.prepared,
        )
        .toEqual({
          kind: 'expression',
          language: 'jsonata',
          expression: '$uppercase(runInput.text)',
        });
      if (process.env.PERTEXO_TRANSFORM_SCREENSHOTS !== undefined)
        await page.screenshot({
          path: `${process.env.PERTEXO_TRANSFORM_SCREENSHOTS}/expressions-phone.png`,
        });
    } else await expect(choose).toBeDisabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
