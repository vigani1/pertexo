import type { WorkflowGraphContract } from '@pertexo/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, delay, http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  addStepButton,
  findCanvas,
} from '../../support/fixtures/editor-actions';
import {
  draftBody,
  editorHandlers,
  editorPath,
  emptyGraph,
  etagA,
  etagB,
  workflowApi,
} from '../../support/fixtures/workflow-editor';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';

describe('workflow editor across tabs', { timeout: 30_000 }, () => {
  it('reopens the last saved draft after visiting another tab', async () => {
    let stored = { graph: emptyGraph, revision: 1, etag: etagA };
    let saves = 0;
    let returning = false;
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      http.get(`${workflowApi}/draft`, async () => {
        // Build renders before its slow re-read of the draft returns.
        if (returning) await delay(1_000);
        return HttpResponse.json(draftBody(stored.graph, stored.revision), {
          headers: { etag: stored.etag },
        });
      }),
      http.put(`${workflowApi}/draft`, async ({ request }) => {
        saves += 1;
        const body = (await request.json()) as { graph: WorkflowGraphContract };
        if (request.headers.get('if-match') !== stored.etag)
          return HttpResponse.json(
            {
              type: 'urn:pertexo:problem:workflow.revision_conflict',
              title: 'Revision conflict',
              status: 412,
              code: 'workflow.revision_conflict',
              requestId: 'conflict-1',
              currentRevision: stored.revision,
              currentEtag: stored.etag,
            },
            {
              status: 412,
              headers: { 'content-type': 'application/problem+json' },
            },
          );
        stored = {
          graph: body.graph,
          revision: stored.revision + 1,
          etag: stored.etag === etagA ? etagB : etagA,
        };
        return HttpResponse.json(draftBody(stored.graph, stored.revision), {
          headers: { etag: stored.etag },
        });
      }),
      http.get(`${workflowApi}/triggers/schedules`, () =>
        HttpResponse.json({ items: [] }),
      ),
      http.get(`${workflowApi}/triggers`, () =>
        HttpResponse.json({ items: [] }),
      ),
      http.get(`${workflowApi}/versions`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get(`${workflowApi}/comments`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await event.click(addStepButton(/Set fields/u));
    await waitFor(() => {
      expect(stored.revision).toBe(2);
    });

    await event.click(screen.getByRole('link', { name: 'Triggers' }));
    await waitFor(() => {
      expect(screen.queryByRole('application')).toBeNull();
    });
    returning = true;
    await event.click(await screen.findByRole('link', { name: 'Build' }));
    await findCanvas();
    await event.click(addStepButton(/Set fields/u));
    await waitFor(() => {
      expect(saves).toBe(2);
    });
    expect(screen.queryByRole('region', { name: 'Draft conflict' })).toBeNull();
    expect(stored.graph.nodes).toHaveLength(2);
  });
});
