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

test('selects human field aliases for later-added opaque column IDs', async ({
  page,
  context,
}) => {
  await addCsrfCookie(context);
  const graph = mappingGraph();
  const remote = remoteDraft({
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (
        typeof node !== 'object' ||
        node === null ||
        !('id' in node) ||
        node.id !== 'target'
      )
        return node;
      return { ...node, definition: { key: 'core.table_find', version: 1 } };
    }),
  });
  await installEditorRoutes(page, remote, {
    definitions: [
      manualDefinition,
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
                id: 'col_opaque',
                name: 'currency',
                type: 'text',
                required: true,
              },
            ],
            keyColumn: null,
            hasRemovedColumns: false,
            rowCount: 0,
            storedBytes: 0,
            revision: 1,
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
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  await page.getByLabel('Workspace table', { exact: true }).click();
  await page.getByRole('option', { name: 'Orders', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Table column bindings' }),
  ).toContainText('currency');
  await expect.poll(() => remote.revision).toBe(2);
  expect(remote.graph.nodes).toContainEqual(
    expect.objectContaining({
      id: 'target',
      config: { table: 'Orders', columnBindings: { currency: 'col_opaque' } },
    }),
  );
});
