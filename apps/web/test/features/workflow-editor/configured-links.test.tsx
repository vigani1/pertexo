import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { platformBrowserNodeDefinitionCatalog } from '@pertexo/node-catalog';
import {
  workflowGraphSchema,
  nodeDefinitionListResponseSchema,
} from '@pertexo/contracts';
import { IncomingLinks } from '@/features/workflow-editor/components/inspector/incoming-links';

it('offers only outputs that are configured on the selected Switch', async () => {
  const graph = workflowGraphSchema.parse({
    nodes: [
      {
        id: 'switch',
        label: 'Choose branch',
        definition: { key: 'core.switch', version: 1 },
        configVersion: 1,
        position: { x: 0, y: 0 },
        config: { cases: [{ id: 'case-01', equals: 'ready' }] },
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'target',
        definition: { key: 'core.set', version: 1 },
        configVersion: 1,
        position: { x: 300, y: 0 },
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
    settings: {},
  });
  const target = graph.nodes[1];
  if (target === undefined) throw new Error('Expected a target');
  render(
    <IncomingLinks
      node={target}
      graph={graph}
      definitions={
        nodeDefinitionListResponseSchema.parse({
          items: platformBrowserNodeDefinitionCatalog().definitions,
        }).items
      }
      editable
      onConnect={() => undefined}
      onRemoveEdge={() => undefined}
    />,
  );
  const event = userEvent.setup();
  await event.click(screen.getByRole('button', { name: 'Link a step' }));
  await event.click(screen.getByRole('combobox', { name: 'Link from step' }));
  await event.click(
    await screen.findByRole('option', { name: 'Choose branch' }),
  );
  await event.click(screen.getByRole('combobox', { name: 'From output' }));
  expect(await screen.findByRole('option', { name: 'case-01' })).toBeVisible();
  expect(
    screen.queryByRole('option', { name: 'case-02' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'default' })).toBeVisible();
});
