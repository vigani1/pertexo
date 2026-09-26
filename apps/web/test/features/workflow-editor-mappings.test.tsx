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
  it('points a step with nothing to set up at its inputs', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: graphWithMappingNodes(),
        definitions: [
          manualDefinition,
          {
            ...mappingDefinition,
            configSchema: { type: 'object', properties: {} },
          },
        ],
      }),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Target'));
    expect(screen.getByText(/Nothing to set up here/u)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit as JSON' })).toBeNull();
    await event.click(screen.getByRole('button', { name: 'Go to Inputs' }));
    expect(screen.getByRole('tab', { name: 'Inputs' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

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
    // A saved input reads as one compact row until it's opened.
    const summary = within(restored).getByRole('button', {
      name: 'draft from no value',
    });
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    expect(within(restored).queryByLabelText('Field')).toBeNull();
    await event.click(summary);
    expect(summary).toHaveAttribute('aria-expanded', 'true');
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

describe('workflow editor input rows', { timeout: 30_000 }, () => {
  it('reads each input as field ← source and opens its editor from the keyboard', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: graphWithMappingNodes({
          customer: {
            kind: 'node_output',
            nodeId: 'manual',
            path: '$.customer',
          },
          active: { kind: 'literal', value: true },
          score: {
            kind: 'expression',
            language: 'jsonata',
            expression: 'amount > 5000',
            policyVersion: 1,
          },
        }),
        definitions: [manualDefinition, mappingDefinition],
      }),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Target'));
    await event.click(screen.getByRole('tab', { name: 'Inputs' }));
    const inputs = within(screen.getByRole('region', { name: 'Inputs' }));
    const rows = inputs
      .getAllByRole('listitem')
      .map((row) => within(row).getByRole('button').textContent);
    expect(rows).toEqual([
      'customer ←from Manual input › customer string',
      'active ←from true boolean',
      'score ←from ƒ expression amount > 5000',
    ]);
    expect(inputs.queryByLabelText('Field')).toBeNull();

    const customer = inputs.getByRole('button', {
      name: 'customer from Manual input › customer string',
    });
    customer.focus();
    await event.keyboard('{Enter}');
    expect(customer).toHaveAttribute('aria-expanded', 'true');
    await event.tab();
    expect(inputs.getByLabelText('Field')).toHaveFocus();
    expect(inputs.getByLabelText('Field')).toHaveValue('customer');
    expect(inputs.getByLabelText('Output path')).toHaveValue('$.customer');
    customer.focus();
    await event.keyboard(' ');
    expect(inputs.queryByLabelText('Field')).toBeNull();

    // Insert data adds a row named after the field, opened to adjust it.
    await event.click(inputs.getByRole('button', { name: 'Insert data' }));
    const picker = await screen.findByRole('dialog', { name: 'Insert data' });
    await event.click(
      within(picker).getByRole('button', { name: /Whole output/u }),
    );
    expect(inputs.getByLabelText('Field')).toHaveFocus();
    expect(inputs.getByLabelText('Field')).toHaveValue('');
    expect(
      inputs.getByRole('button', { name: 'Unnamed input from Manual input' }),
    ).toHaveAttribute('aria-expanded', 'true');
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

    await event.click(screen.getByRole('button', { name: 'Connect a step' }));
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
