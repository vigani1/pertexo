import {
  nodeDefinitionListResponseSchema,
  workflowDraftResponseSchema,
  workflowGraphSchema,
} from '@pertexo/contracts';
import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/index.js';
import { authorCollectionGraph } from '../../../e2e-live/support/authoring/transforms';
import { createWorkspaceFixture } from '../../../test/support/fixtures/identity';
import { expect, test } from '../../support/fixtures';
import { mappingGraph } from '../graph';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  user,
  workflowId,
  workspaceId,
  type RemoteDraft,
} from '../support';

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
  // Nine steps and their ordinary debounced saves share the live journey's budget.
  test.setTimeout(60_000);
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
            accessibleWorkspace: createWorkspaceFixture({
              id: workspaceId,
              role: 'viewer',
              capabilities: ['workspace:read', 'workflow:read'],
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
            }),
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

for (const width of [1280, 375])
  test(`keeps Date variants exact, undoable and usable at ${String(width)}px`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
    const base = workflowGraphSchema.parse(mappingGraph());
    const remote = remoteDraft({
      ...base,
      settings: { ...base.settings },
      nodes: base.nodes.map((node) =>
        node.id === 'target'
          ? {
              ...node,
              definition: { key: 'core.date', version: 1 },
              config: { operation: 'to_iso' },
            }
          : node,
      ),
    });
    await installEditorRoutes(page, remote, { definitions });
    await page.goto(editorUrl);
    await page.getByTestId('rf__node-target').click();
    if (width === 375)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true })
        .click();
    const change = async (label: string) => {
      await page.getByLabel('Date operation', { exact: true }).click();
      await page.getByRole('option', { name: label, exact: true }).click();
    };
    await change('Format timestamp');
    await page.getByLabel('Time zone', { exact: true }).fill('Europe/Paris');
    await page.keyboard.press('Tab');
    await expect
      .poll(
        () =>
          workflowGraphSchema
            .parse(remote.graph)
            .nodes.find((node) => node.id === 'target')?.config,
      )
      .toEqual({
        operation: 'format',
        format: 'date_only',
        timeZone: 'Europe/Paris',
      });
    await change('Add or subtract duration');
    await expect(page.getByLabel('Time zone', { exact: true })).toHaveCount(0);
    await expect(
      page.getByLabel('Duration unit', { exact: true }),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Setup', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect
      .poll(
        () =>
          workflowGraphSchema
            .parse(remote.graph)
            .nodes.find((node) => node.id === 'target')?.config,
      )
      .toEqual({
        operation: 'format',
        format: 'date_only',
        timeZone: 'Europe/Paris',
      });
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect
      .poll(
        () =>
          workflowGraphSchema
            .parse(remote.graph)
            .nodes.find((node) => node.id === 'target')?.config,
      )
      .toEqual({ operation: 'add_duration', unit: 'days' });
    await change('Convert time zone');
    await page
      .getByLabel('Time zone', { exact: true })
      .fill('America/New_York');
    await page.keyboard.press('Tab');
    await expect
      .poll(
        () =>
          workflowGraphSchema
            .parse(remote.graph)
            .nodes.find((node) => node.id === 'target')?.config,
      )
      .toEqual({ operation: 'convert_timezone', timeZone: 'America/New_York' });
    await page.reload();
    await page.getByTestId('rf__node-target').click();
    if (width === 375)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true })
        .click();
    await expect(page.getByLabel('Time zone', { exact: true })).toHaveValue(
      'America/New_York',
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await testInfo.attach(`date-setup-${String(width)}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
      await page.screenshot({
        path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/date-setup-${String(width)}.png`,
        fullPage: true,
      });
  });
