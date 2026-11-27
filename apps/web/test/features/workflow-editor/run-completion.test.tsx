import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { findCanvas } from '../../support/fixtures/editor-actions';
import { oneStepGraph } from '../../support/fixtures/editor-graph';
import {
  coldStart,
  sseEvents,
  statisticsHandler,
} from '../../support/fixtures/run';
import {
  api,
  deferred,
  editorHandlers,
  editorPath,
  publishedWorkflowHandlers,
  runId,
  runSummary,
  user,
  versionId,
  workflowApi,
  workspaceId,
} from '../../support/fixtures/workflow-editor';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';

it.each(['succeeded', 'outcome_unknown'] as const)(
  'shows a run that finishes with %s after starting it in the editor',
  async (status) => {
    const run = runSummary(runId, versionId, 'queued');
    const runApi = `${api}/workspaces/${workspaceId}/runs`;
    const [step] = oneStepGraph.nodes;
    if (step === undefined) throw new Error('Expected a step in the fixture');
    const label = 'Read order';
    const graph = { ...oneStepGraph, nodes: [{ ...step, label }] };
    const completedAt = run.updatedAt;
    const detailRequested = deferred<void>();
    const releaseDetails = deferred<void>();
    let accepted = false;
    let completed = false;
    mockServer.use(
      http.get(`${api}/users/me`, async () => {
        // The acceptance identity check overlaps the editor's refreshed last run.
        if (accepted) await detailRequested.promise;
        return HttpResponse.json(user);
      }),
      http.get(`${workflowApi}/comments`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      statisticsHandler(),
      ...publishedWorkflowHandlers(graph),
      ...editorHandlers(() => undefined, { graph }),
      http.post(`${workflowApi}/runs`, () => {
        accepted = true;
        return HttpResponse.json({ run, replayed: false }, { status: 202 });
      }),
      http.get(runApi, () =>
        HttpResponse.json({ items: accepted ? [run] : [], nextCursor: null }),
      ),
      http.get(`${runApi}/${runId}/input`, () =>
        HttpResponse.json({ input: { kind: 'none' } }),
      ),
      http.get(`${runApi}/${runId}/node-runs/:nodeRunId/input`, () =>
        HttpResponse.json({ input: { kind: 'none' } }),
      ),
      http.get(`${runApi}/${runId}/node-runs/:nodeRunId/output`, () =>
        HttpResponse.json({ output: { kind: 'none' } }),
      ),
      http.get(`${runApi}/${runId}`, async () => {
        detailRequested.resolve();
        await releaseDetails.promise;
        return HttpResponse.json({
          run: completed ? { ...run, status, completedAt } : run,
          nodes: completed
            ? [
                {
                  id: '22222222-2222-4222-8222-222222222222',
                  nodeId: step.id,
                  invocationKey: `${step.id}:0`,
                  status,
                  currentAttemptNumber: 1,
                  startedAt: run.startedAt,
                  completedAt,
                  resumeAt: null,
                  safeErrorCode: null,
                },
              ]
            : [],
        });
      }),
      http.get(`${runApi}/${runId}/events`, () => {
        completed = true;
        return new HttpResponse(sseEvents([{ type: `run.${status}` }]), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
    );
    await renderLoadedApp(editorPath);
    await findCanvas();
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Run', exact: true }),
    );
    await event.click(
      await screen.findByRole('menuitem', { name: 'Run published version' }),
    );
    // Opening the pending run page removes the editor before the API replies.
    try {
      await screen.findByRole('status', { name: 'Loading' });
    } finally {
      releaseDetails.resolve();
    }
    expect(
      await screen.findByRole(
        'tab',
        { name: 'Timeline', selected: true },
        coldStart,
      ),
    ).toBeVisible();
    if (status === 'outcome_unknown') {
      expect(
        await screen.findByRole('region', { name: /Pertexo can’t tell/u }),
      ).toBeVisible();
    } else {
      expect(
        await screen.findByRole('button', { name: /^Read order: Succeeded/u }),
      ).toBeVisible();
    }
  },
);
