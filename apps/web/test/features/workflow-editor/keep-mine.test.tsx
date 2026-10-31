import type { WorkflowGraphContract } from '@pertexo/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import {
  addStepButton,
  findCanvas,
  pressSave,
} from '../../support/fixtures/editor-actions';
import {
  draftBody,
  editorHandlers,
  editorPath,
  emptyGraph,
  etagA,
  etagB,
  manualDefinition,
  setDefinition,
  workflowApi,
} from '../../support/fixtures/workflow-editor';
import { graphWithMappingNodes } from '../../support/fixtures/editor-graph';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';

/** Someone else really saved revision 3, holding `theirs`, so the first save is refused. */
function installRealConflict(theirs: WorkflowGraphContract) {
  const puts: { ifMatch: string | null; graph: WorkflowGraphContract }[] = [];
  let draftReads = 0;
  mockServer.use(
    ...editorHandlers(() => undefined, {
      definitions: [manualDefinition, setDefinition],
    }),
  );
  mockServer.use(
    http.get(`${workflowApi}/draft`, () => {
      draftReads += 1;
      return draftReads === 1
        ? HttpResponse.json(draftBody(emptyGraph, 2), {
            headers: { etag: etagA },
          })
        : HttpResponse.json(draftBody(theirs, 3), {
            headers: { etag: etagB },
          });
    }),
    http.put(`${workflowApi}/draft`, async ({ request }) => {
      const { graph } = (await request.json()) as {
        graph: WorkflowGraphContract;
      };
      puts.push({ ifMatch: request.headers.get('if-match'), graph });
      return puts.length === 1
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
        : HttpResponse.json(draftBody(graph, 4), {
            headers: { etag: `"draft.${'c'.repeat(43)}"` },
          });
    }),
  );
  return puts;
}

async function reachConflict() {
  renderApp(editorPath);
  const event = userEvent.setup();
  await findCanvas();
  await event.click(addStepButton(/Set fields/u));
  pressSave();
  const bar = await screen.findByRole('region', { name: 'Draft conflict' });
  expect(within(bar).getByText('Changed elsewhere (revision 3)')).toBeVisible();
  return { bar, event };
}

function canvasStepNames() {
  return within(screen.getByRole('application'));
}

describe('Keep mine on a real conflict', { timeout: 30_000 }, () => {
  it('keeps my step on the canvas when their draft is empty', async () => {
    installRealConflict(emptyGraph);
    const { bar, event } = await reachConflict();
    await event.click(within(bar).getByRole('button', { name: 'Keep mine' }));
    expect(canvasStepNames().getByText('Set fields')).toBeInTheDocument();
  });

  it('saves my graph over theirs, from their revision, and clears the conflict', async () => {
    const puts = installRealConflict({
      ...emptyGraph,
      nodes: graphWithMappingNodes().nodes.slice(0, 1),
    });
    const { bar, event } = await reachConflict();
    await event.click(within(bar).getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => {
      expect(puts).toHaveLength(2);
    });
    expect(puts[1]?.ifMatch).toBe(etagB);
    expect(
      puts[1]?.graph.nodes.map(({ definition }) => definition.key),
    ).toEqual(['core.set']);
    expect(canvasStepNames().getByText('Set fields')).toBeInTheDocument();
    expect(canvasStepNames().queryByText('Manual input')).toBeNull();
    await waitFor(() => {
      expect(screen.getByText(/^Saved/u)).toBeVisible();
    });
    expect(screen.queryByText(/Changed elsewhere/u)).toBeNull();
  });

  it('Load theirs replaces my step with theirs and stops saving mine', async () => {
    const puts = installRealConflict({
      ...emptyGraph,
      nodes: graphWithMappingNodes().nodes.slice(0, 1),
    });
    const { bar, event } = await reachConflict();
    await event.click(within(bar).getByRole('button', { name: 'Load theirs' }));
    expect(canvasStepNames().getByText('Manual input')).toBeInTheDocument();
    expect(canvasStepNames().queryByText('Set fields')).toBeNull();
    expect(puts).toHaveLength(1);
  });
});
