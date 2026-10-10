import type { WorkflowGraphContract } from '@pertexo/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  editorHandlers,
  editorPath,
  findCanvas,
  graphWithMappingNodes,
  manualDefinition,
  mappingDefinition,
  pressSave,
} from '../../support/fixtures/workflow-editor';

describe('workflow callable contract editor', { timeout: 30_000 }, () => {
  it('lets readers inspect the declaration without applying changes', async () => {
    const graph: WorkflowGraphContract = {
      ...graphWithMappingNodes(),
      callable: {
        input: { type: 'string' },
        resultType: { type: 'string' },
        result: { kind: 'run_input', path: '$' },
      },
    };
    mockServer.use(
      ...editorHandlers(
        () => {
          throw new Error('A reader must not save');
        },
        {
          graph,
          definitions: [manualDefinition, mappingDefinition],
          capabilities: ['workflow:read', 'run:read'],
        },
      ),
    );
    renderApp(editorPath);
    const user = userEvent.setup();
    await findCanvas();
    await user.click(screen.getByRole('button', { name: 'Workflow contract' }));
    const dialog = within(
      screen.getByRole('dialog', { name: 'Workflow contract' }),
    );
    expect(dialog.queryByRole('button', { name: 'Apply contract' })).toBeNull();
    expect(dialog.getByRole('textbox', { name: 'Result path' })).toBeDisabled();
    await user.click(dialog.getByRole('button', { name: 'Close' }));
  });
  it('keeps incomplete properties local, preserves focus through renames, and applies one undoable contract', async () => {
    let saved: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          saved = body.graph;
        },
        {
          graph: graphWithMappingNodes(),
          definitions: [manualDefinition, mappingDefinition],
        },
      ),
    );
    renderApp(editorPath, { strict: true });
    const user = userEvent.setup();
    await findCanvas();
    await user.click(screen.getByRole('button', { name: 'Workflow contract' }));
    const dialog = within(
      screen.getByRole('dialog', { name: 'Workflow contract' }),
    );
    await user.click(
      dialog.getByRole('checkbox', { name: 'Declare a callable contract' }),
    );
    const input = within(dialog.getByRole('group', { name: 'Accepted input' }));
    await user.click(input.getByRole('button', { name: 'Add property' }));
    await user.click(dialog.getByRole('button', { name: 'Apply contract' }));
    expect(input.getByRole('alert')).toHaveTextContent(
      'Fill in the property name.',
    );
    expect(saved?.callable).toBeUndefined();
    const name = input.getByRole('textbox', { name: 'Property name' });
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    await user.type(name, 'customer');
    expect(name).toHaveFocus();
    await user.click(
      within(
        dialog.getByRole('group', { name: 'Returned value' }),
      ).getByLabelText('Value type'),
    );
    await user.click(await screen.findByRole('option', { name: 'String' }));
    await user.clear(dialog.getByRole('textbox', { name: 'Result path' }));
    await user.type(
      dialog.getByRole('textbox', { name: 'Result path' }),
      '$.customer',
    );
    await user.click(dialog.getByRole('button', { name: 'Apply contract' }));
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Workflow contract' }),
      ).toBeNull();
    });
    pressSave();
    await waitFor(() => {
      expect(saved?.callable).toEqual({
        input: {
          type: 'object',
          properties: [
            { name: 'customer', required: true, valueType: { type: 'string' } },
          ],
        },
        resultType: { type: 'string' },
        result: { kind: 'run_input', path: '$.customer' },
      });
    });
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    pressSave();
    await waitFor(() => {
      expect(saved?.callable).toBeUndefined();
    });
  });

  it('confirms dismissal and retains unapplied edits when people keep editing', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: graphWithMappingNodes(),
        definitions: [manualDefinition, mappingDefinition],
      }),
    );
    renderApp(editorPath);
    const user = userEvent.setup();
    await findCanvas();
    await user.click(screen.getByRole('button', { name: 'Workflow contract' }));
    const dialog = within(
      screen.getByRole('dialog', { name: 'Workflow contract' }),
    );
    await user.click(
      dialog.getByRole('checkbox', { name: 'Declare a callable contract' }),
    );
    await user.keyboard('{Escape}');
    expect(
      await screen.findByRole('dialog', { name: 'Discard contract changes?' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(
      dialog.getByRole('checkbox', { name: 'Declare a callable contract' }),
    ).toBeChecked();
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Workflow contract' }),
      ).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Workflow contract' }));
    expect(
      screen.getByRole('checkbox', { name: 'Declare a callable contract' }),
    ).not.toBeChecked();
  });
});
