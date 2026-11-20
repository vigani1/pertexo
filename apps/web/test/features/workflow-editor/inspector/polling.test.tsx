import { nodeDefinitionCatalogItemSchema } from '@pertexo/contracts';
import { platformBrowserNodeDefinitionCatalog } from '@pertexo/node-catalog';
import {
  HTTP_POLL_TRIGGER,
  TRIGGER_INTERVAL_MINUTES,
} from '@pertexo/workflow-model';
import { fireEvent, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { findCanvas } from '../../../support/fixtures/editor-actions';
import { oneStepGraph } from '../../../support/fixtures/editor-graph';
import {
  editorHandlers,
  editorPath,
} from '../../../support/fixtures/workflow-editor';
import { mockServer } from '../../../support/mock-server';
import { renderLoadedApp } from '../../../support/render-app';

it('shows feed fields, an optional HTTP connection and guidance on which items will start runs', async () => {
  const { definitions } = platformBrowserNodeDefinitionCatalog();
  const polling = definitions.find(
    ({ definition }) => definition.key === HTTP_POLL_TRIGGER.key,
  );
  if (polling === undefined)
    throw new Error('HTTP Polling is missing from the catalog');
  const graph = oneStepGraph;
  const node = graph.nodes[0];
  if (node === undefined) throw new Error('Missing editor fixture step');
  mockServer.use(
    ...editorHandlers(() => undefined, {
      graph: {
        ...graph,
        nodes: [
          {
            ...node,
            label: 'Watch feed',
            definition: HTTP_POLL_TRIGGER,
            config: {
              url: 'https://example.test/feed',
              intervalMinutes: TRIGGER_INTERVAL_MINUTES.minimum,
              itemsPath: '$',
              itemKeyPath: '$.id',
            },
          },
        ],
      },
      definitions: [nodeDefinitionCatalogItemSchema.parse(polling)],
    }),
  );
  await renderLoadedApp(editorPath);
  fireEvent.click((await findCanvas()).getByText('Watch feed'));
  expect(await screen.findByLabelText('Feed URL')).toHaveValue(
    'https://example.test/feed',
  );
  expect(screen.getByLabelText('Item key path')).toHaveValue('$.id');
  expect(screen.getByLabelText('HTTP connection')).toBeVisible();
  expect(
    screen.getByText(
      /first successful check after publishing.*starts no runs/u,
    ),
  ).toBeVisible();
  expect(
    screen.getByText(/unique, stable key.*last 1,000 items.*up to 100 items/u),
  ).toBeVisible();
});
