import { HttpResponse, http } from 'msw';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  apiBase,
  coldStart,
  fixtureIds,
  fixtureRun,
  fixtureVersion,
  identityHandlers,
  sseEvents,
  statisticsHandler,
} from '../support/run-fixtures';

const {
  workspace: workspaceId,
  workflow: workflowId,
  firstRun: runId,
  secondRun: failedRunId,
} = fixtureIds;
const fetchRunId = '33333333-3333-4333-8333-333333333333';
const sendRunId = '44444444-4444-4444-8444-444444444444';
const capabilities = [
  'workspace:read',
  'workflow:read',
  'run:read',
  'artifact:read',
];

function step(id: string, label: string, key: string) {
  return {
    id,
    label,
    definition: { key, version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  };
}

const graph = {
  schemaVersion: 1,
  nodes: [
    step('fetch-order', 'Fetch order', 'core.http_request'),
    step('send-receipt', 'Send receipt', 'email.send_message'),
  ],
  edges: [
    {
      id: 'fetch-to-send',
      source: { nodeId: 'fetch-order', port: 'out' },
      target: { nodeId: 'send-receipt', port: 'in' },
    },
  ],
  settings: {},
};

function nodeRun(id: string, nodeId: string, secondsAgo: number) {
  const at = new Date(Date.now() - secondsAgo * 1_000).toISOString();
  return {
    id,
    nodeId,
    invocationKey: `${workflowId}|${nodeId}|b:|i:`,
    status: 'succeeded',
    currentAttemptNumber: 1,
    startedAt: at,
    completedAt: at,
    resumeAt: null,
    safeErrorCode: null,
  };
}

function installTwoStepRun(recorded: unknown = { kind: 'none' }) {
  mockServer.use(
    http.get(
      `${apiBase}/runs/${runId}/node-runs/:nodeRunId/input`,
      ({ params }) =>
        HttpResponse.json({
          input: params.nodeRunId === sendRunId ? recorded : { kind: 'none' },
        }),
    ),
    ...identityHandlers(capabilities),
    statisticsHandler(),
    http.get(`${apiBase}/runs/${runId}`, () =>
      HttpResponse.json({
        run: fixtureRun(runId, 'succeeded'),
        nodes: [
          nodeRun(fetchRunId, 'fetch-order', 4),
          nodeRun(sendRunId, 'send-receipt', 2),
        ],
      }),
    ),
    http.get(
      `${apiBase}/runs/${runId}/events`,
      () =>
        new HttpResponse(sseEvents([{ type: 'run.succeeded' }]), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ),
    http.get(`${apiBase}/workflows/${workflowId}/versions`, () =>
      HttpResponse.json({ items: [fixtureVersion(graph)], nextCursor: null }),
    ),
    http.get(`${apiBase}/runs/${runId}/input`, () =>
      HttpResponse.json({ input: { kind: 'inline', value: { orderId: 7 } } }),
    ),
    http.get(
      `${apiBase}/runs/${runId}/node-runs/:nodeRunId/output`,
      ({ params }) =>
        HttpResponse.json({
          output:
            params.nodeRunId === fetchRunId
              ? { kind: 'inline', value: { total: 42, currency: 'EUR' } }
              : { kind: 'none' },
        }),
    ),
  );
}

describe('run data', () => {
  it('shows what a step received from the step before it and what it returned', async () => {
    installTwoStepRun();
    renderApp(`/w/${workspaceId}/runs/${runId}`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole(
        'button',
        { name: /^Send receipt: Succeeded/u },
        coldStart,
      ),
    );
    // Without a wide screen the chosen step opens in a sheet.
    const lens = await screen.findByRole('dialog', { name: 'Send receipt' });
    expect(within(lens).getByText('Fetch order')).toBeVisible();
    const dataIn = await within(lens).findByRole('group', {
      name: 'Data out of Fetch order',
    });
    expect(dataIn).toHaveTextContent(/total: 42/u);
    expect(
      await within(lens).findByText(
        'This step finished without returning anything.',
      ),
    ).toBeVisible();

    // A wide view of the same value, for when the panel is too narrow.
    await event.click(
      within(lens).getByRole('button', {
        name: 'Expand Data out of Fetch order',
      }),
    );
    const expanded = await screen.findByRole('dialog', {
      name: 'Data out of Fetch order',
    });
    expect(expanded).toHaveAccessibleDescription('2 fields · 29 B');

    await event.click(within(expanded).getByRole('button', { name: 'Close' }));
    await event.click(
      within(lens).getByRole('button', { name: 'About Data in' }),
    );
    expect(
      await screen.findByText(
        /Exactly what this step received, as it started/u,
      ),
    ).toBeVisible();
  });

  it('shows exactly what a step received when its attempt recorded it', async () => {
    installTwoStepRun({
      kind: 'inline',
      value: { amount: 42, to: 'ops@example.test' },
    });
    renderApp(`/w/${workspaceId}/runs/${runId}`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole(
        'button',
        { name: /^Send receipt: Succeeded/u },
        coldStart,
      ),
    );
    const lens = await screen.findByRole('dialog', { name: 'Send receipt' });
    expect(
      await within(lens).findByRole('group', {
        name: 'Data in of Send receipt',
      }),
    ).toHaveTextContent(/amount: 42/u);
    // Where it came from stays folded, and unread, until it's opened.
    const origin = within(lens).getByText('Where it came from');
    const sources = origin.closest('details');
    expect(sources).not.toHaveTextContent(/From Fetch order/u);
    await event.click(origin);
    expect(sources).toHaveTextContent(/From Fetch order/u);
    expect(
      await within(lens).findByRole('group', {
        name: 'Data out of Fetch order',
      }),
    ).toHaveTextContent(/total: 42/u);
  });

  it('names where a failed run went wrong in the list, and explains statuses', async () => {
    mockServer.use(
      ...identityHandlers(capabilities),
      statisticsHandler(),
      http.get(`${apiBase}/workflows`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get(`${apiBase}/runs`, () =>
        HttpResponse.json({
          items: [
            fixtureRun(failedRunId, 'failed', {
              failedStep: {
                nodeId: 'charge',
                label: 'Charge card',
                definitionKey: 'core.http_request',
                safeErrorCode: 'provider.timeout',
              },
            }),
            fixtureRun(runId, 'succeeded', { failedStep: null }),
          ],
          nextCursor: null,
        }),
      ),
    );
    renderApp(`/w/${workspaceId}/runs`);
    const reason = await screen.findByText(/Charge card/u, {}, coldStart);
    expect(reason.closest('p')).toHaveTextContent(/^at Charge card · /u);

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'What these mean' }));
    const guide = await screen.findByRole('dialog', {
      name: 'What these mean',
    });
    expect(within(guide).getByText('Outcome unknown')).toBeVisible();
    expect(
      within(guide).getByText(/Check that service before you run it again/u),
    ).toBeVisible();
  });
});
