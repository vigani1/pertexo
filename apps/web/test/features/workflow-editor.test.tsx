import { HttpResponse, http } from 'msw';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  addStepButton,
  choose,
  draftBody,
  editorHandlers,
  editorPath,
  emptyGraph,
  etagA,
  etagB,
  findCanvas,
  graphWithMappingNodes,
  graphWithNumericConfig,
  manualDefinition,
  mappingDefinition,
  numericDefinition,
  pressSave,
  setDefinition,
  toastAction,
  workflowApi,
  workspaceId,
} from '../support/workflow-editor-fixtures';

// The lazy editor route and React Flow are slow to start on a busy machine.

describe('workflow editor canvas', { timeout: 30_000 }, () => {
  it('places a step in view and conditionally autosaves the domain graph', async () => {
    let savedNodes = 0;
    mockServer.use(
      ...editorHandlers((request, body) => {
        expect(request.headers.get('if-match')).toBe(etagA);
        expect(request.headers.get('x-csrf-token')).toBeTruthy();
        savedNodes = body.graph.nodes.length;
      }),
    );
    renderApp(editorPath, { strict: true });
    const event = userEvent.setup();
    await findCanvas();
    expect(
      screen.getByRole('heading', { name: 'Start with a trigger' }),
    ).toBeVisible();
    await event.click(addStepButton(/Set fields/u));
    expect(screen.getByText('Unsaved')).toBeVisible();
    await waitFor(() => {
      expect(savedNodes).toBe(1);
    });
    expect(await screen.findByText(/^Saved/u)).toBeVisible();
    expect(
      within(screen.getByRole('application')).getByText('Set fields'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Label')).toHaveAttribute(
      'placeholder',
      'Set fields',
    );
  });

  it('deletes and duplicates selected steps with the keyboard and offers Undo', async () => {
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
    screen.getByRole('region', { name: 'Workflow canvas' }).focus();
    fireEvent.keyDown(window, { key: 'd', metaKey: true });
    await waitFor(() => {
      expect(canvas.getAllByText('Target')).toHaveLength(2);
    });

    fireEvent.click(canvas.getByText('Manual input'));
    screen.getByRole('region', { name: 'Workflow canvas' }).focus();
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(await screen.findByText('Deleted “Manual input”')).toBeVisible();
    expect(canvas.queryByText('Manual input')).toBeNull();
    await event.click(toastAction('Undo'));
    expect(canvas.getByText('Manual input')).toBeInTheDocument();

    pressSave();
    await waitFor(() => {
      expect(savedGraph?.nodes.map((node) => node.label)).toEqual([
        'Manual input',
        'Target',
        'Target',
      ]);
    });
  });

  it('keeps text fields protected from canvas shortcuts', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: graphWithMappingNodes(),
        definitions: [manualDefinition, mappingDefinition],
      }),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    const canvas = await findCanvas();
    fireEvent.click(canvas.getByText('Target'));
    const label = screen.getByLabelText('Label');
    await event.clear(label);
    await event.type(label, 'Renamed/step');
    fireEvent.keyDown(label, { key: 'Backspace' });
    expect(label).toHaveValue('Renamed/step');
    expect(canvas.getByText('Renamed/step')).toBeInTheDocument();
    expect(canvas.getByText('Manual input')).toBeInTheDocument();
  });
});

describe('workflow editor setup fields', { timeout: 30_000 }, () => {
  it('edits schema fields live and keeps invalid numbers as scratch', async () => {
    let savedGraph: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          savedGraph = body.graph;
        },
        {
          graph: graphWithNumericConfig({
            count: 4,
            requiredCount: 1,
            unknown: { preserved: true },
          }),
          definitions: [numericDefinition],
        },
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Numbers'));
    const count = screen.getByLabelText('Count');
    fireEvent.change(count, { target: { value: '-' } });
    expect(screen.getByText('Count must be a number.')).toBeVisible();
    fireEvent.change(count, { target: { value: '-2.5' } });
    expect(screen.queryByText('Count must be a number.')).toBeNull();
    await event.click(
      screen.getByRole('button', { name: 'Increase Required count' }),
    );
    await event.click(screen.getByRole('switch', { name: 'Enabled' }));
    await choose(event, 'Mode', 'fast');
    await event.type(screen.getByLabelText('Value'), 'field edit');

    await event.click(screen.getByRole('button', { name: 'Edit as JSON' }));
    const json = screen.getByLabelText('Setup as JSON');
    expect(json).toHaveValue(
      JSON.stringify(
        {
          count: -2.5,
          requiredCount: 2,
          unknown: { preserved: true },
          enabled: true,
          mode: 'fast',
          value: 'field edit',
        },
        null,
        2,
      ),
    );
    fireEvent.change(json, { target: { value: '{"count": ' } });
    expect(
      screen.getByRole('button', { name: 'Back to fields' }),
    ).toBeDisabled();
    await event.click(screen.getByRole('button', { name: 'Discard it' }));
    expect(screen.getByRole('button', { name: 'Edit as JSON' })).toBeVisible();
    expect(screen.getByLabelText('Count')).toHaveValue('-2.5');

    pressSave();
    await waitFor(() => {
      expect(savedGraph?.nodes[0]?.config).toEqual({
        count: -2.5,
        requiredCount: 2,
        unknown: { preserved: true },
        enabled: true,
        mode: 'fast',
        value: 'field edit',
      });
    });
  });

  it('continues autosaving after the StrictMode effect lifecycle replay', async () => {
    let savedNodes = 0;
    mockServer.use(
      ...editorHandlers((_request, body) => {
        savedNodes = body.graph.nodes.length;
      }),
    );
    renderApp(editorPath, { strict: true });
    const event = userEvent.setup();
    await findCanvas();
    await event.click(addStepButton(/Set fields/u));
    pressSave();
    await waitFor(() => {
      expect(savedNodes).toBe(1);
    });
    expect(await screen.findByText(/^Saved/u)).toBeVisible();
  });
});

describe('workflow editor guards and conflicts', { timeout: 30_000 }, () => {
  it('asks before leaving with unsaved changes and can save first', async () => {
    let saves = 0;
    const save = deferredSave();
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      http.put(`${workflowApi}/draft`, async ({ request }) => {
        saves += 1;
        const body = (await request.json()) as { graph: WorkflowGraphContract };
        await save.promise;
        return HttpResponse.json(draftBody(body.graph, 2), {
          headers: { etag: etagB },
        });
      }),
      http.get(`${workflowApi.replace(/\/workflows\/.*/u, '')}/workflows`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    const app = renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await event.click(addStepButton(/Set fields/u));
    await event.click(screen.getByRole('link', { name: 'Back to workflows' }));
    expect(
      await screen.findByRole('heading', {
        name: 'Leave with unsaved changes?',
      }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Stay here' }));
    expect(app.router.state.location.pathname).toBe(editorPath);

    await event.click(screen.getByRole('link', { name: 'Back to workflows' }));
    await event.click(
      await screen.findByRole('button', { name: 'Save and leave' }),
    );
    save.resolve();
    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe(
        `/w/${workspaceId}/workflows`,
      );
    });
    expect(saves).toBeGreaterThanOrEqual(1);
  });

  it('stops saving on a conflict, keeps both drafts and re-applies a kept step', async () => {
    const remote: WorkflowGraphContract = {
      ...emptyGraph,
      nodes: graphWithMappingNodes().nodes.slice(0, 1),
    };
    let draftReads = 0;
    let saves = 0;
    mockServer.use(
      ...editorHandlers(() => undefined, {
        definitions: [manualDefinition, setDefinition],
      }),
    );
    mockServer.use(
      http.get(`${workflowApi}/draft`, () => {
        draftReads += 1;
        return draftReads === 1
          ? HttpResponse.json(draftBody(emptyGraph, 1), {
              headers: { etag: etagA },
            })
          : HttpResponse.json(draftBody(remote, 3), {
              headers: { etag: etagB },
            });
      }),
      http.put(`${workflowApi}/draft`, () => {
        saves += 1;
        return saves === 1
          ? HttpResponse.json(
              {
                type: 'urn:pertexo:problem:workflow.revision_conflict',
                title: 'Revision conflict',
                status: 412,
                code: 'workflow.revision_conflict',
                requestId: 'conflict-1',
                currentRevision: 3,
                currentEtag: etagB,
              },
              {
                status: 412,
                headers: { 'content-type': 'application/problem+json' },
              },
            )
          : HttpResponse.json(draftBody(remote, 4), {
              headers: { etag: etagA },
            });
      }),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await event.click(addStepButton(/Set fields/u));
    pressSave();
    const bar = await screen.findByRole('region', { name: 'Draft conflict' });
    expect(
      within(bar).getByText('Changed elsewhere (revision 3)'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Review' })).toBeVisible();

    await event.click(within(bar).getByRole('button', { name: 'Compare' }));
    expect(
      screen.getByText('only in your copy', { exact: false }),
    ).toBeVisible();
    expect(
      screen.getByText('not in your copy', { exact: false }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Close' }));

    await event.click(within(bar).getByRole('button', { name: 'Keep mine' }));
    expect(
      within(screen.getByRole('region', { name: 'Draft conflict' })).getByText(
        'Your copy is kept for comparison',
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole('application')).getByText('Manual input'),
    ).toBeInTheDocument();
    await event.click(screen.getByRole('button', { name: 'Compare' }));
    await event.click(
      screen.getByRole('button', { name: 'Use your copy of Set fields' }),
    );
    await event.click(screen.getByRole('button', { name: 'Close' }));
    expect(
      within(screen.getByRole('application')).getByText('Set fields'),
    ).toBeInTheDocument();
    await event.click(screen.getByRole('button', { name: 'Dismiss copy' }));
    expect(screen.queryByRole('region', { name: 'Draft conflict' })).toBeNull();
  });
});

function deferredSave() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
