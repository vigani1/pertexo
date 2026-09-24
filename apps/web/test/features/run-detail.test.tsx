import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  apiBase,
  fixtureIds,
  fixtureRun,
  fixtureVersion,
  identityHandlers,
  sseEvents,
  coldStart,
} from '../support/run-fixtures';

const {
  workspace: workspaceId,
  workflow: workflowId,
  firstRun: runId,
} = fixtureIds;
const artifactId = '55555555-5555-4555-8555-555555555555';
const capabilities = [
  'workspace:read',
  'workflow:read',
  'run:read',
  'run:cancel',
  'connection:read',
  'artifact:read',
];

function secondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1_000).toISOString();
}

const graph = {
  schemaVersion: 1,
  nodes: [
    {
      id: 'send-receipt',
      label: 'Send receipt',
      definition: { key: 'email.send_message', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    },
  ],
  edges: [],
  settings: {},
};

function node(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    nodeId: 'send-receipt',
    invocationKey: 'send-receipt:0',
    status,
    currentAttemptNumber: 1,
    startedAt: secondsAgo(45),
    completedAt: null,
    resumeAt: null,
    safeErrorCode: null,
    ...overrides,
  };
}

function stepEvent(type: string, secondsBack: number, payload = {}) {
  return {
    type,
    createdAt: secondsAgo(secondsBack),
    payload: {
      schemaVersion: 1,
      nodeId: 'send-receipt',
      invocationKey: 'send-receipt:0',
      ...payload,
    },
  };
}

function installRun({
  run,
  nodes,
  events,
  stream,
}: Readonly<{
  run: ReturnType<typeof fixtureRun>;
  nodes: readonly unknown[];
  events?: readonly Readonly<{ type: string }>[];
  stream?: () => Response;
}>) {
  let streams = 0;
  mockServer.use(
    ...identityHandlers(capabilities),
    http.get(`${apiBase}/runs/${runId}`, () =>
      HttpResponse.json({ run, nodes }),
    ),
    http.get(`${apiBase}/runs/${runId}/events`, () => {
      streams += 1;
      return (
        stream?.() ??
        new HttpResponse(sseEvents(events ?? []), {
          headers: { 'content-type': 'text/event-stream' },
        })
      );
    }),
    http.get(`${apiBase}/workflows/${workflowId}/versions`, () =>
      HttpResponse.json({ items: [fixtureVersion(graph)], nextCursor: null }),
    ),
    http.get(`${apiBase}/runs`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
  return { streamCount: () => streams };
}

const retryingRun = () =>
  fixtureRun(runId, 'running', {
    startedAt: secondsAgo(47),
    createdAt: secondsAgo(47),
  });

const retryEvents = () => [
  stepEvent('node.started', 45, { attemptNumber: 1 }),
  stepEvent('node.retry_scheduled', 44, {
    attemptNumber: 1,
    dueAt: secondsAgo(-60),
    safeErrorCode: 'provider.unavailable',
  }),
];

describe('run page', () => {
  it('tells a retrying run’s story in a sentence, a thread and the step lens', async () => {
    installRun({
      run: retryingRun(),
      nodes: [node('waiting', { resumeAt: secondsAgo(-60) })],
      events: retryEvents(),
    });
    renderApp(`/w/${workspaceId}/runs/${runId}`);

    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: 'Retrying Send receipt' },
        coldStart,
      ),
    ).toBeVisible();
    expect(screen.getByText('v7')).toHaveAttribute(
      'href',
      `/w/${workspaceId}/workflows/${workflowId}/versions`,
    );
    const step = await screen.findByRole('button', {
      name: /^Send receipt: Waiting, retry in/u,
    });
    const lens = screen.getByRole('complementary', { name: 'Step details' });
    expect(await within(lens).findByText('Retry scheduled')).toBeVisible();
    expect(
      within(lens).getByText(
        'The service this step calls was unavailable, so the step didn’t finish.',
      ),
    ).toBeVisible();
    expect(within(lens).getByText('provider.unavailable')).toBeVisible();

    const event = userEvent.setup();
    await event.click(step);
    const sheet = await screen.findByRole('dialog', { name: 'Send receipt' });
    expect(within(sheet).getByText('Attempt 1 failed')).toBeVisible();

    await event.keyboard('{Escape}');
    await event.click(screen.getByRole('tab', { name: /Events/u }));
    expect(
      await screen.findByText(/retry scheduled in 1m \d\ds/u),
    ).toBeVisible();
    expect(screen.getByText('node.retry_scheduled')).toBeVisible();
  });

  it('asks before stopping a run and confirms the request', async () => {
    let cancels = 0;
    installRun({
      run: retryingRun(),
      nodes: [node('waiting', { resumeAt: secondsAgo(-60) })],
      events: retryEvents(),
    });
    mockServer.use(
      http.post(`${apiBase}/runs/${runId}/cancel`, () => {
        cancels += 1;
        const { workflowName, ...summary } = retryingRun();
        void workflowName;
        return HttpResponse.json({
          run: { ...summary, cancelRequestedAt: secondsAgo(0) },
          alreadyRequested: false,
        });
      }),
    );
    renderApp(`/w/${workspaceId}/runs/${runId}`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Cancel run' }, coldStart),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Stop this run?',
    });
    expect(
      within(dialog).getByText(/Steps that already finished aren’t undone./u),
    ).toBeVisible();
    expect(cancels).toBe(0);
    await event.click(within(dialog).getByRole('button', { name: 'Stop run' }));
    expect(await screen.findByText('Stopping the run')).toBeVisible();
    expect(cancels).toBe(1);
  });

  it('explains an unknown outcome before anyone replays', async () => {
    installRun({
      run: fixtureRun(runId, 'outcome_unknown'),
      nodes: [node('outcome_unknown', { completedAt: secondsAgo(1) })],
      events: [{ type: 'run.outcome_unknown' }],
    });
    renderApp(`/w/${workspaceId}/runs/${runId}`);
    expect(
      await screen.findByRole(
        'heading',
        { name: 'Pertexo can’t tell whether Send receipt finished' },
        coldStart,
      ),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Outcome unknown at Send receipt',
      }),
    ).toBeVisible();
  });

  it('says in words when live updates pause and reconnects on request', async () => {
    const run = installRun({
      run: retryingRun(),
      nodes: [node('running')],
      stream: () =>
        HttpResponse.json(
          {
            type: 'urn:pertexo:problem:forbidden',
            title: 'Forbidden',
            status: 403,
            code: 'auth.forbidden',
            requestId: 'stream-forbidden',
          },
          {
            status: 403,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
    });
    renderApp(`/w/${workspaceId}/runs/${runId}`);
    expect(
      await screen.findByText('Updates paused', undefined, coldStart),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(run.streamCount()).toBe(2);
    });
  });

  it('offers file outputs and is honest about inline results and input', async () => {
    mockServer.use(
      http.get(`${apiBase}/artifacts/${artifactId}`, () =>
        HttpResponse.json({
          id: artifactId,
          workspaceId,
          byteLength: 2_048,
          mediaType: 'text/csv',
          sha256: 'a'.repeat(64),
          status: 'available',
          createdAt: '2026-09-14T10:00:00.000Z',
          expiresAt: null,
        }),
      ),
    );
    installRun({
      run: fixtureRun(runId, 'succeeded'),
      nodes: [node('succeeded', { completedAt: secondsAgo(1) })],
      events: [
        stepEvent('node.started', 3, { attemptNumber: 1 }),
        stepEvent('node.succeeded', 2, {
          attemptNumber: 1,
          outputRef: { kind: 'artifact', artifactId },
        }),
        { type: 'run.succeeded' },
      ],
    });
    renderApp(`/w/${workspaceId}/runs/${runId}`);
    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: 'Succeeded in 2.0 s' },
        coldStart,
      ),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('tab', { name: 'Input & output' }));
    const panel = screen.getByRole('tabpanel');
    expect(await within(panel).findByText('CSV file')).toBeVisible();
    expect(
      within(panel).getByRole('button', { name: 'Download' }),
    ).toBeVisible();
    expect(
      within(panel).getByText(/the API doesn’t return it to the app yet/u),
    ).toBeVisible();
  });
});
