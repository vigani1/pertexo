import type { WorkflowGraphContract } from '@pertexo/contracts';

import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { describe, expect, it } from 'vitest';

import {
  choose,
  findCanvas,
  pressSave,
  toastAction,
} from '../../../../support/fixtures/editor-actions';
import { graphWithMappingNodes } from '../../../../support/fixtures/editor-graph';
import {
  editorHandlers,
  editorPath,
  manualDefinition,
  mappingDefinition,
} from '../../../../support/fixtures/workflow-editor';

import { mockServer } from '../../../../support/mock-server';

import { renderApp } from '../../../../support/render-app';

describe('workflow editor input sources', { timeout: 30_000 }, () => {
  it('keeps a disconnected step-output mapping and clears its warning when reconnected', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: {
          ...graphWithMappingNodes({
            customer: {
              kind: 'node_output',
              nodeId: 'manual',
              path: '$.customer',
            },
          }),
          edges: [],
        },
        definitions: [manualDefinition, mappingDefinition],
      }),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Target'));
    await event.click(screen.getByRole('tab', { name: 'Inputs' }));
    expect(
      screen.getByText('The source must be a directly linked predecessor.'),
    ).toBeVisible();
    expect(screen.getByLabelText('Source step')).toHaveAttribute(
      'aria-invalid',
      'true',
    );

    await event.click(screen.getByRole('button', { name: 'Link a step' }));
    await choose(event, 'Link from step', 'Manual input');
    await choose(event, 'From output', 'out');
    await choose(event, 'Into input', 'in');
    await event.click(screen.getByRole('button', { name: 'Link' }));
    expect(
      screen.queryByText('The source must be a directly linked predecessor.'),
    ).toBeNull();
    expect(screen.getByLabelText('Field')).toHaveValue('customer');
    expect(
      screen.getByRole('button', {
        name: 'Remove link from Manual input',
      }),
    ).toBeVisible();
  });
  it('removes an input and a connection with Undo instead of a confirmation', async () => {
    let savedGraph: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          savedGraph = body.graph;
        },
        {
          graph: graphWithMappingNodes({
            loop: { kind: 'structured_input', port: 'item', path: '$.id' },
          }),
          definitions: [manualDefinition, mappingDefinition],
        },
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Target'));
    await event.click(screen.getByRole('tab', { name: 'Inputs' }));
    const inputs = screen.getByRole('region', { name: 'Inputs' });
    // Outside a For each body, a loop-item source is kept but called out.
    const outsideBody = /Only steps inside a For each body can read/u;
    expect(within(inputs).getByText(outsideBody)).toBeVisible();
    await event.click(
      within(inputs).getByRole('button', { name: 'Remove the loop input' }),
    );
    expect(within(inputs).queryByText(outsideBody)).toBeNull();
    expect(await screen.findByText('Removed the “loop” input')).toBeVisible();
    await event.click(toastAction('Undo'));
    expect(within(inputs).getByText(outsideBody)).toBeVisible();

    await event.click(
      screen.getByRole('button', {
        name: 'Remove link from Manual input',
      }),
    );
    expect(await screen.findByText('Link removed')).toBeVisible();
    pressSave();
    await waitFor(() => {
      expect(savedGraph?.edges).toEqual([]);
    });
  });
});
