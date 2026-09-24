import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  choose,
  editorHandlers,
  editorPath,
  findCanvas,
  graphWithMappingNodes,
  manualDefinition,
  mappingDefinition,
  pressSave,
  toastAction,
} from '../support/workflow-editor-fixtures';

// The lazy editor route and React Flow are slow to start on a busy machine.

describe('workflow editor live input mappings', { timeout: 30_000 }, () => {
  it('applies typed input mappings live and saves them through the draft pipeline', async () => {
    let savedGraph: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          savedGraph = body.graph;
        },
        {
          graph: graphWithMappingNodes(),
          definitions: [manualDefinition, mappingDefinition],
        },
      ),
    );
    renderApp(editorPath, { strict: true });
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Target'));
    await event.click(screen.getByRole('tab', { name: 'Inputs' }));
    const inputs = screen.getByRole('region', { name: 'Inputs' });
    expect(within(inputs).getByText(/No input mappings/u)).toBeVisible();

    await event.click(
      within(inputs).getByRole('button', { name: 'Add input' }),
    );
    let rows = within(inputs).getAllByRole('listitem');
    await event.type(
      within(rows[0] ?? inputs).getByLabelText('Field'),
      'customer',
    );
    await event.click(
      within(rows[0] ?? inputs).getByRole('button', { name: 'Step output' }),
    );
    const outputPath = within(rows[0] ?? inputs).getByLabelText('Output path');
    await event.clear(outputPath);
    await event.type(outputPath, '$.customer');

    await event.click(
      within(inputs).getByRole('button', { name: 'Add input' }),
    );
    rows = within(inputs).getAllByRole('listitem');
    await event.type(
      within(rows[1] ?? inputs).getByLabelText('Field'),
      'requestedBy',
    );
    await event.click(
      within(rows[1] ?? inputs).getByRole('button', { name: 'Run input' }),
    );
    const runPath = within(rows[1] ?? inputs).getByLabelText('Run input path');
    await event.clear(runPath);
    await event.type(runPath, '$.actor.name');

    await event.click(
      within(inputs).getByRole('button', { name: 'Add input' }),
    );
    rows = within(inputs).getAllByRole('listitem');
    await event.type(
      within(rows[2] ?? inputs).getByLabelText('Field'),
      'active',
    );
    await event.click(
      within(rows[2] ?? inputs).getByRole('switch', { name: 'Value' }),
    );

    expect(screen.getByText('Unsaved')).toBeVisible();
    pressSave();
    await waitFor(() => {
      expect(savedGraph?.nodes[1]?.inputMappings).toEqual({
        customer: { kind: 'node_output', nodeId: 'manual', path: '$.customer' },
        requestedBy: { kind: 'run_input', path: '$.actor.name' },
        active: { kind: 'literal', value: true },
      });
    });
    expect(await screen.findByText(/^Saved/u)).toBeVisible();

    const undo = screen.getByRole('button', { name: 'Undo' });
    while (!undo.hasAttribute('disabled')) await event.click(undo);
    expect(
      within(screen.getByRole('region', { name: 'Inputs' })).getByText(
        /No input mappings/u,
      ),
    ).toBeVisible();
    const redo = screen.getByRole('button', { name: 'Redo' });
    while (!redo.hasAttribute('disabled')) await event.click(redo);
    expect(
      within(screen.getByRole('region', { name: 'Inputs' })).getAllByRole(
        'listitem',
      ),
    ).toHaveLength(3);
  });

  it('keeps an unfinished input as scratch and guards switching steps', async () => {
    let savedGraph: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          savedGraph = body.graph;
        },
        {
          graph: graphWithMappingNodes(),
          definitions: [manualDefinition, mappingDefinition],
        },
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    const canvas = await findCanvas();
    fireEvent.click(canvas.getByText('Target'));
    await event.click(screen.getByRole('tab', { name: 'Inputs' }));
    const inputs = screen.getByRole('region', { name: 'Inputs' });
    await event.click(
      within(inputs).getByRole('button', { name: 'Add input' }),
    );
    await event.type(within(inputs).getByLabelText('Field'), 'draft');
    fireEvent.change(within(inputs).getByLabelText('JSON value'), {
      target: { value: '{' },
    });
    expect(
      within(inputs).getByText('Literal value must be valid JSON.'),
    ).toBeVisible();
    expect(
      screen.getByText('An edit isn’t valid yet, so it isn’t saved.'),
    ).toBeVisible();
    expect(screen.getByText('Unsaved')).toBeVisible();

    fireEvent.click(canvas.getByText('Manual input'));
    expect(
      await screen.findByRole('heading', {
        name: 'Discard the unfinished edit?',
      }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Stay' }));
    expect(within(inputs).getByLabelText('JSON value')).toHaveValue('{');

    fireEvent.click(canvas.getByText('Manual input'));
    await event.click(
      await screen.findByRole('button', { name: 'Discard edit' }),
    );
    expect(
      screen.getByText(/receives the run’s input directly/u),
    ).toBeVisible();
    fireEvent.click(canvas.getByText('Target'));
    const restored = screen.getByRole('region', { name: 'Inputs' });
    expect(within(restored).getByLabelText('Field')).toHaveValue('draft');
    expect(within(restored).getByLabelText('JSON value')).toHaveValue('null');
    pressSave();
    await waitFor(() => {
      expect(savedGraph?.nodes[1]?.inputMappings).toEqual({
        draft: { kind: 'literal', value: null },
      });
    });
  });
});

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
      screen.getByText('The source must be a directly connected predecessor.'),
    ).toBeVisible();
    expect(screen.getByLabelText('Source step')).toHaveAttribute(
      'aria-invalid',
      'true',
    );

    await choose(event, 'Connect from step', 'Manual input');
    await choose(event, 'From output', 'out');
    await choose(event, 'Into input', 'in');
    await event.click(screen.getByRole('button', { name: 'Connect' }));
    expect(
      screen.queryByText(
        'The source must be a directly connected predecessor.',
      ),
    ).toBeNull();
    expect(screen.getByLabelText('Field')).toHaveValue('customer');
    expect(
      screen.getByRole('button', {
        name: 'Remove connection from Manual input',
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
    expect(within(inputs).getByText(/Loop input/u)).toBeVisible();
    await event.click(
      within(inputs).getByRole('button', { name: 'Remove the loop input' }),
    );
    expect(within(inputs).queryByText(/Loop input/u)).toBeNull();
    expect(await screen.findByText('Removed the “loop” input')).toBeVisible();
    await event.click(toastAction('Undo'));
    expect(within(inputs).getByText(/Loop input/u)).toBeVisible();

    await event.click(
      screen.getByRole('button', {
        name: 'Remove connection from Manual input',
      }),
    );
    expect(await screen.findByText('Connection removed')).toBeVisible();
    pressSave();
    await waitFor(() => {
      expect(savedGraph?.edges).toEqual([]);
    });
  });
});
