import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  editorHandlers,
  editorPath,
  findCanvas,
} from '../../support/workflow-editor-fixtures';
import {
  nativeCallGraph,
  workflowCallPin,
} from '../../support/workflow-call-fixtures';

describe('native Call configuration in the editor', { timeout: 30_000 }, () => {
  it('edits an exact pin through ordinary save without changing mappings or enabling tests', async () => {
    let saved: WorkflowGraphContract | undefined;
    const initial = nativeCallGraph();
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          saved = body.graph;
        },
        { graph: initial },
      ),
    );
    renderApp(editorPath, { strict: true });
    const user = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Call child'));
    expect(screen.getByLabelText('Child workflow ID')).toHaveValue(
      workflowCallPin.workflowId,
    );
    const version = screen.getByLabelText('Pinned version ID');
    fireEvent.change(version, { target: { value: 'latest' } });
    fireEvent.blur(version);
    expect(version).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Edit as JSON' })).toBeDisabled();
    expect(saved).toBeUndefined();
    const nextId = '33333333-3333-4333-8333-333333333333';
    fireEvent.change(version, { target: { value: nextId } });
    await waitFor(() => {
      expect(saved?.nodes[0]?.config.versionId).toBe(nextId);
    });
    expect(saved?.nodes[0]?.config).toEqual({
      ...workflowCallPin,
      versionId: nextId,
    });
    expect(saved?.nodes[0]?.inputMappings).toEqual(
      initial.nodes[0]?.inputMappings,
    );
    expect(await screen.findByText(/^Saved/u)).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Test' }));
    expect(
      within(screen.getByRole('tabpanel', { name: 'Test' })).getByText(
        'Native step testing and execution are not enabled.',
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Test step' }),
    ).not.toBeInTheDocument();
  });
  it('keeps unknown future configuration visible and intact in JSON', async () => {
    const config = { ...workflowCallPin, futureOption: { keep: true } };
    mockServer.use(
      ...editorHandlers(() => undefined, { graph: nativeCallGraph(config) }),
    );
    renderApp(editorPath, { strict: true });
    fireEvent.click((await findCanvas()).getByText('Call child'));
    expect(
      JSON.parse(
        screen.getByLabelText<HTMLTextAreaElement>('Setup as JSON').value,
      ),
    ).toEqual(config);
    expect(
      screen.queryByLabelText('Pinned version ID'),
    ).not.toBeInTheDocument();
  });
  it('disables the typed pin for a read-only actor', async () => {
    const save = vi.fn();
    mockServer.use(
      ...editorHandlers(save, {
        graph: nativeCallGraph(),
        capabilities: ['workspace:read', 'workflow:read'],
      }),
    );
    renderApp(editorPath, { strict: true });
    fireEvent.click((await findCanvas()).getByText('Call child'));
    expect(screen.getByLabelText('Pinned version ID')).toBeDisabled();
    expect(screen.getByLabelText('Callable contract identity')).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
  });
});
