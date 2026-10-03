import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  emptyCallableDeclaration,
  setCallableDeclaration,
} from '@/features/workflow-editor/model/graph/callable-contract';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  addStepButton,
  editorHandlers,
  editorPath,
  findCanvas,
  graphWithMappingNodes,
} from '../../support/workflow-editor-fixtures';

describe('workflow callable inspector', { timeout: 30_000 }, () => {
  it('applies and autosaves a native contract through the ordinary draft endpoint', async () => {
    let saved: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          saved = body.graph;
        },
        { graph: graphWithMappingNodes() },
      ),
    );
    renderApp(editorPath, { strict: true });
    const user = userEvent.setup();
    await findCanvas();
    await user.click(screen.getByRole('button', { name: 'Callable contract' }));
    await user.click(
      screen.getByRole('button', { name: 'Add callable contract' }),
    );
    const panel = screen.getByRole('region', { name: 'Callable contract' });
    fireEvent.change(within(panel).getByLabelText('Input type'), {
      target: {
        value:
          '{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}',
      },
    });
    fireEvent.change(within(panel).getByLabelText('Result source'), {
      target: { value: '{"kind":"run_input","path":"$"}' },
    });
    await waitFor(() => {
      expect(saved).toMatchObject({
        schemaVersion: 2,
        callable: {
          input: { required: ['name'] },
          resultSelector: { kind: 'run_input', path: '$' },
        },
      });
    });
    expect(saved?.nodes).toHaveLength(2);
    expect(await screen.findByText(/^Saved/u)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /^Publish/u }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Run/u }),
    ).not.toBeInTheDocument();
    await user.click(
      within(panel).getByRole('button', { name: 'Remove callable contract' }),
    );
    await waitFor(() => {
      expect(saved).not.toHaveProperty('callable');
    });
    expect(saved?.schemaVersion).toBe(2);
  });

  it('aggregates unfinished fields and guards closing and step selection', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, { graph: graphWithMappingNodes() }),
    );
    renderApp(editorPath, { strict: true });
    const user = userEvent.setup();
    await findCanvas();
    await user.click(screen.getByRole('button', { name: 'Callable contract' }));
    await user.click(
      screen.getByRole('button', { name: 'Add callable contract' }),
    );
    const panel = screen.getByRole('region', { name: 'Callable contract' });
    const input = within(panel).getByLabelText('Input type');
    const source = within(panel).getByLabelText('Result source');
    fireEvent.change(input, { target: { value: '{' } });
    fireEvent.change(source, { target: { value: '{' } });
    fireEvent.change(input, {
      target: { value: '{"type":"object","properties":{},"required":[]}' },
    });
    expect(within(panel).getByText('Unapplied contract text')).toBeVisible();
    expect(
      within(panel).getByRole('button', { name: 'Remove callable contract' }),
    ).toBeDisabled();
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(
      screen.getByRole('dialog', { name: 'Discard the unfinished edit?' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Stay' }));
    expect(source).toHaveValue('{');
    await user.click(addStepButton(/Set fields/u));
    // Placement is independent; selecting its new step must not discard scratch.
    expect(source).toHaveValue('{');
    await user.click(
      within(panel).getByRole('button', { name: 'Discard unapplied text' }),
    );
    expect(screen.getByLabelText('Result source')).not.toHaveValue('{');
    fireEvent.change(screen.getByLabelText('Result source'), {
      target: { value: '{' },
    });
    fireEvent.click((await findCanvas()).getByText('Target'));
    expect(
      screen.getByRole('dialog', { name: 'Discard the unfinished edit?' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Discard edit' }));
    expect(screen.getByLabelText('Label')).toHaveValue('Target');
    expect(
      screen.queryByText('Unapplied contract text'),
    ).not.toBeInTheDocument();
  });
  it('shows an existing native declaration read-only without offering execution', async () => {
    const save = vi.fn();
    mockServer.use(
      ...editorHandlers(save, {
        graph: setCallableDeclaration(
          graphWithMappingNodes(),
          emptyCallableDeclaration(),
        ),
        capabilities: ['workspace:read', 'workflow:read'],
      }),
    );
    renderApp(editorPath, { strict: true });
    await findCanvas();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Callable contract' }));
    for (const label of ['Input type', 'Result type', 'Result source']) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(
      screen.getByRole('button', { name: 'Remove callable contract' }),
    ).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: /^Publish/u }),
    ).not.toBeInTheDocument();
  });
});
