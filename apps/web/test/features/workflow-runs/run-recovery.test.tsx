import type { AccessibleWorkspace } from '@pertexo/contracts';
import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  apiBase,
  fixtureIds,
  fixtureRun,
  identityHandlers,
  sseEvents,
  coldStart,
  statisticsHandler,
} from '../../support/fixtures/run';
const workspaceId = fixtureIds.workspace,
  sourceRunId = fixtureIds.firstRun,
  newRunId = fixtureIds.replayRun;
const preview = {
  kind: 'eligible',
  workflowVersionId: fixtureIds.version,
  versionNumber: 1,
  nodeRunId: sourceRunId,
  nodeId: 'http',
  nodeLabel: 'Send request',
  reusedCount: 2,
  sourceCompletedAt: '2026-10-13T00:00:00.000Z',
  effectRisk: 'possible_effects',
};
function acceptedRun() {
  const { workflowName: _, ...run } = fixtureRun(newRunId, 'queued');
  return run;
}
function install(
  capabilities: Readonly<AccessibleWorkspace['capabilities']> = [
    'workspace:read',
    'run:read',
    'run:replay',
  ],
) {
  mockServer.use(
    ...identityHandlers(capabilities),
    statisticsHandler(),
    http.get(`${apiBase}/runs/:runId`, ({ params }) =>
      HttpResponse.json({
        run: fixtureRun(String(params.runId), 'failed'),
        nodes: [],
      }),
    ),
    http.get(
      `${apiBase}/runs/:runId/events`,
      () =>
        new HttpResponse(sseEvents([{ type: 'run.failed' }]), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ),
    http.get(`${apiBase}/runs`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get(`${apiBase}/runs/:runId/recovery`, () =>
      HttpResponse.json(preview),
    ),
    http.get(`${apiBase}/runs/:runId/input`, () =>
      HttpResponse.json({ input: { kind: 'none' } }),
    ),
  );
}
async function open() {
  await userEvent
    .setup()
    .click(
      await screen.findByRole(
        'button',
        { name: 'Retry from this step' },
        coldStart,
      ),
    );
  return screen.findByRole('dialog', { name: 'Retry from this step' });
}
describe('failed-step recovery confirmation', () => {
  it('requires an unchecked acknowledgement and sends no editable input', async () => {
    install();
    const bodies: unknown[] = [];
    mockServer.use(
      http.post(
        `${apiBase}/runs/${sourceRunId}/recover`,
        async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json(
            { run: acceptedRun(), replayed: false },
            { status: 202 },
          );
        },
      ),
    );
    const { router } = renderApp(`/w/${workspaceId}/runs/${sourceRunId}`);
    const dialog = await open();
    const checkbox = await within(dialog).findByRole('checkbox');
    expect(checkbox).not.toBeChecked();
    const retry = within(dialog).getByRole('button', { name: 'Retry anyway' });
    expect(retry).toBeDisabled();
    expect(
      within(dialog).queryByLabelText(/input.*JSON/u),
    ).not.toBeInTheDocument();
    await userEvent.setup().click(checkbox);
    await userEvent.setup().click(retry);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${newRunId}`,
      );
    });
    expect(bodies).toEqual([
      {
        workflowVersionId: fixtureIds.version,
        nodeRunId: sourceRunId,
        acknowledgePossibleEffects: true,
      },
    ]);
  });
  it('requires the stronger acknowledgement for unknown outcomes and preserves the attention card', async () => {
    install();
    const bodies: unknown[] = [];
    mockServer.use(
      http.get(`${apiBase}/runs/${sourceRunId}`, () =>
        HttpResponse.json({
          run: fixtureRun(sourceRunId, 'outcome_unknown'),
          nodes: [],
        }),
      ),
      http.get(`${apiBase}/runs/${sourceRunId}/recovery`, () =>
        HttpResponse.json({
          ...preview,
          effectRisk: 'unknown_outcome',
        }),
      ),
      http.post(
        `${apiBase}/runs/${sourceRunId}/recover`,
        async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json(
            { run: acceptedRun(), replayed: false },
            { status: 202 },
          );
        },
      ),
    );
    renderApp(`/w/${workspaceId}/runs/${sourceRunId}`);
    await screen.findByRole(
      'region',
      { name: /Pertexo can’t tell/u },
      coldStart,
    );
    const dialog = await open();
    expect(dialog).toHaveTextContent(
      "We don't know whether this step reached the service. Retrying can repeat its effect.",
    );
    const retry = within(dialog).getByRole('button', { name: 'Retry anyway' });
    expect(retry).toBeDisabled();
    const checkbox = within(dialog).getByRole('checkbox');
    expect(checkbox).not.toBeChecked();
    await userEvent.setup().click(checkbox);
    await userEvent.setup().click(retry);
    await waitFor(() => {
      expect(bodies).toEqual([
        {
          workflowVersionId: fixtureIds.version,
          nodeRunId: sourceRunId,
          acknowledgeUnknownOutcome: true,
        },
      ]);
    });
  });
  it('retains a lost acceptance response across close and exact retry even when source preview retires', async () => {
    install();
    let retired = false;
    const keys: string[] = [],
      bodies: unknown[] = [];
    mockServer.use(
      http.get(`${apiBase}/runs/${sourceRunId}/recovery`, () =>
        HttpResponse.json(
          retired ? { kind: 'refused', reason: 'values_expired' } : preview,
        ),
      ),
      http.post(
        `${apiBase}/runs/${sourceRunId}/recover`,
        async ({ request }) => {
          keys.push(request.headers.get('idempotency-key') ?? '');
          bodies.push(await request.json());
          if (keys.length === 1) {
            retired = true;
            return HttpResponse.error();
          }
          return HttpResponse.json(
            { run: acceptedRun(), replayed: true },
            { status: 202 },
          );
        },
      ),
    );
    const { router } = renderApp(`/w/${workspaceId}/runs/${sourceRunId}`);
    let dialog = await open();
    await userEvent.setup().click(await within(dialog).findByRole('checkbox'));
    await userEvent
      .setup()
      .click(within(dialog).getByRole('button', { name: 'Retry anyway' }));
    dialog = await screen.findByRole('dialog', { name: 'Retry same request' });
    await userEvent
      .setup()
      .click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Retry same request' }));
    dialog = await screen.findByRole('dialog', { name: 'Retry same request' });
    await userEvent
      .setup()
      .click(
        within(dialog).getByRole('button', { name: 'Retry same request' }),
      );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${newRunId}`,
      );
    });
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(bodies[1]).toEqual(bodies[0]);
  });
  it('explains unsupported recovery and keeps full replay separately confirmed', async () => {
    install();
    let writes = 0;
    mockServer.use(
      http.get(`${apiBase}/runs/${sourceRunId}/recovery`, () =>
        HttpResponse.json({ kind: 'refused', reason: 'unsupported_graph' }),
      ),
      http.post(`${apiBase}/runs/${sourceRunId}/recover`, () => {
        writes += 1;
        return HttpResponse.error();
      }),
    );
    renderApp(`/w/${workspaceId}/runs/${sourceRunId}`);
    const dialog = await open();
    await waitFor(() =>
      expect(dialog).toHaveAccessibleDescription(/does not yet support/u),
    );
    await userEvent
      .setup()
      .click(within(dialog).getByRole('button', { name: 'Use full replay…' }));
    expect(
      await screen.findByRole('dialog', { name: 'Replay this run' }),
    ).toHaveAccessibleDescription(/steps.*run again/iu);
    expect(writes).toBe(0);
  });
  it('does not offer recovery without replay authority', async () => {
    install(['workspace:read', 'run:read']);
    renderApp(`/w/${workspaceId}/runs/${sourceRunId}`);
    await screen.findByRole('heading', { name: /Failed/u }, coldStart);
    expect(
      screen.queryByRole('button', { name: 'Retry from this step' }),
    ).not.toBeInTheDocument();
  });
});
