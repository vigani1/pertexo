import { workflowGraphSchema } from '@pertexo/contracts';
import { expect, test } from '../../support/fixtures';
import { mappingGraph } from '../graph';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  remoteDraft,
  workspaceId,
} from '../support';
for (const width of [1280, 375])
  test(`reviews renamed table fields before one undoable draft change at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    const base = workflowGraphSchema.parse(mappingGraph());
    const target = base.nodes[1];
    if (target === undefined) throw new Error('Target missing');
    const oldPath = {
      kind: 'node_output',
      nodeId: 'target',
      path: '$.rows[0].values.amount',
    } as const;
    const remote = remoteDraft({
      ...base,
      settings: {},
      nodes: [
        ...base.nodes.filter((node) => node.id !== target.id),
        {
          ...target,
          definition: { key: 'core.table_find', version: 1 },
          config: { table: 'Orders', columnBindings: { amount: 'id_amount' } },
        },
        {
          ...target,
          id: 'later',
          label: 'Summarize later',
          position: { x: 700, y: 80 },
          inputMappings: { value: oldPath },
        },
      ],
      edges: [
        ...base.edges,
        {
          id: 'target-later',
          source: { nodeId: 'target', port: 'out' },
          target: { nodeId: 'later', port: 'in' },
        },
      ],
    });
    await installEditorRoutes(page, remote, {
      definitions: [
        manualDefinition,
        definition,
        { ...definition, definition: { key: 'core.table_find', version: 1 } },
      ],
    });
    await page.route(`**/v1/workspaces/${workspaceId}/data-tables`, (route) =>
      route.fulfill({
        json: {
          tables: [
            {
              id: '10000000-0000-4000-8000-000000000001',
              name: 'Orders',
              columns: [
                {
                  id: 'id_amount',
                  name: 'total',
                  type: 'number',
                  required: false,
                },
              ],
              keyColumn: null,
              hasRemovedColumns: false,
              rowCount: 0,
              storedBytes: 0,
              revision: 2,
            },
          ],
          quotas: {
            tableLimit: 20,
            columnLimit: 20,
            rowLimit: 10000,
            byteLimit: 52428800,
            tableCount: 1,
            storedBytes: 0,
          },
        },
      }),
    );
    await page.goto(editorUrl);
    await page.getByTestId('rf__node-target').click();
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true })
        .click();
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    const bindings = page.getByRole('region', {
      name: 'Table column bindings',
    });
    await expect(bindings).toContainText('amount (now called total)');
    expect(remote.revision).toBe(1);
    await bindings
      .getByRole('button', { name: 'Use the new name', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Review column names' });
    await expect(
      dialog.getByLabel('Later references', { exact: true }),
    ).toContainText('Summarize later → value');
    await expect(dialog).toContainText('$.rows[0].values.amount');
    await expect(dialog).toContainText(
      'Mappings and input data are not rewritten',
    );
    await page.screenshot({
      path: `/tmp/pertexo-column-name-review-${String(width)}.png`,
    });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(remote.revision).toBe(1);
    await bindings
      .getByRole('button', { name: 'Use the new name', exact: true })
      .click();
    await dialog
      .getByRole('button', { name: 'Use the new name', exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(bindings).toContainText('total');
    await expect.poll(() => remote.revision).toBe(2);
    const saved = workflowGraphSchema.parse(remote.graph);
    expect(saved.nodes.find((node) => node.id === 'target')?.config).toEqual({
      table: 'Orders',
      columnBindings: { total: 'id_amount' },
    });
    expect(
      saved.nodes.find((node) => node.id === 'later')?.inputMappings,
    ).toEqual({ value: oldPath });
    await page.keyboard.press('ControlOrMeta+z');
    await expect(bindings).toContainText('amount (now called total)');
    await expect.poll(() => remote.revision).toBe(3);
    await page.reload();
    await page.getByTestId('rf__node-target').click();
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true })
        .click();
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await expect(bindings).toContainText('amount (now called total)');
    expect(remote.revision).toBe(3);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
