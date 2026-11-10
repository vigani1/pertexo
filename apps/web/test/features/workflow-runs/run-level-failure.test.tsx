import { screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import { fixtureRun, apiBase } from '../../support/fixtures/run';
import { installRun, runId, workspaceId } from './detail/route/fixture';

it('explains a run-level failure and why saved-result recovery is unavailable without a failed step', async () => {
  installRun({
    run: fixtureRun(runId, 'failed', {
      failureReasonCode: 'execution.run_state_invalid',
    }),
    nodes: [],
  });
  mockServer.use(
    http.get(`${apiBase}/runs/${runId}/recovery`, () =>
      HttpResponse.json({ kind: 'refused', reason: 'evidence_unavailable' }),
    ),
  );
  await renderLoadedApp(`/w/${workspaceId}/runs/${runId}`);
  expect(
    await screen.findByText(/saved execution state is invalid/i),
  ).toBeVisible();
  expect(
    await screen.findByText(/no failed step.*saved results/i),
  ).toBeVisible();
  const main = screen.getByRole('main');
  expect(
    within(main).queryByText('execution.run_state_invalid'),
  ).not.toBeInTheDocument();
});

it('explains a run-level result failure in the history list without a failed-step row', async () => {
  installRun({ run: fixtureRun(runId, 'failed'), nodes: [] });
  mockServer.use(
    http.get(`${apiBase}/runs`, () =>
      HttpResponse.json({
        items: [
          fixtureRun(runId, 'failed', {
            failureReasonCode: 'callable_result_invalid',
            failedStep: null,
          }),
        ],
        nextCursor: null,
      }),
    ),
  );
  await renderLoadedApp(`/w/${workspaceId}/runs`);
  expect(
    await screen.findByText(/result does not match its declared result type/i),
  ).toBeVisible();
});

it('uses the same safe cause in the terminal timeline and never prints unknown diagnostic text', async () => {
  const { describeRunEvent } =
    await import('@/features/workflow-runs/model/timeline/event-copy');
  const createdAt = '2026-09-15T10:00:00.000Z';
  const event = {
    sequence: 1,
    type: 'run.failed' as const,
    createdAt,
    payload: { reasonCode: 'callable_result_invalid' },
  };
  expect(
    describeRunEvent(event, Date.parse(createdAt), () => undefined).sentence,
  ).toBe(
    'Run failed · The workflow’s result does not match its declared result type. Fix the result mapping or type and publish again.',
  );
  expect(
    describeRunEvent(
      { ...event, payload: { reasonCode: 'private-provider-diagnostic' } },
      Date.parse(createdAt),
      () => undefined,
    ).sentence,
  ).toBe('Run failed');
});
