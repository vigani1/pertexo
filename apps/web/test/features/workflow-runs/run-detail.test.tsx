import { HttpResponse, http } from 'msw';
import type { WorkflowRunResponse } from '@pertexo/contracts/schemas/workflow-runs';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  apiBase,
  fixtureIds,
  fixtureRun,
  fixtureStatistics,
  fixtureVersion,
  identityHandlers,
  sseEvents,
  coldStart,
} from '../../support/run-fixtures';
import { workflowRunKeys } from '@/features/workflow-runs/workflow-runs.queries';

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
  input = { kind: 'none' },
  output = { kind: 'none' },
  callFamily,
}: Readonly<{
  run: ReturnType<typeof fixtureRun>;
  nodes: readonly unknown[];
  events?: readonly Readonly<{ type: string }>[];
  stream?: () => Response;
  input?: unknown;
  output?: unknown;
  callFamily?: WorkflowRunResponse['callFamily'];
}>) {
  let streams = 0;
  mockServer.use(
    ...identityHandlers(capabilities),
    http.get(`${apiBase}/runs/${runId}/input`, () =>
      HttpResponse.json({ input }),
    ),
    http.get(`${apiBase}/runs/${runId}/node-runs/:nodeRunId/output`, () =>
      HttpResponse.json({ output }),
    ),
    http.get(`${apiBase}/runs/${runId}/node-runs/:nodeRunId/input`, () =>
      HttpResponse.json({ input: { kind: 'none' } }),
    ),
    http.get(`${apiBase}/runs/${runId}`, () =>
      HttpResponse.json({
        run,
        nodes,
        ...(callFamily === undefined ? {} : { callFamily }),
      }),
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

/** Pretend the screen is a phone for the run page's layout queries. */
function emulatePhoneScreen() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query === '(max-width: 47.999rem)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('run page', () => {
  it('shows only the selected invocation’s accepted child, refreshes its status and forgets denied snapshots', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: query === '(min-width: 48rem)',
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    const firstChild = fixtureIds.secondRun;
    const secondChild = artifactId;
    const nodes = [
      node('succeeded', { completedAt: secondsAgo(30) }),
      node('failed', {
        id: '33333333-3333-4333-8333-333333333333',
        invocationKey: 'send-receipt:1',
        completedAt: secondsAgo(20),
      }),
    ];
    const callFamily: NonNullable<WorkflowRunResponse['callFamily']> = {
      rootRunId: runId,
      parentRunId: null,
      parentInvocationKey: null,
      children: [
        {
          runId: firstChild,
          nodeId: 'send-receipt',
          invocationKey: 'send-receipt:0',
          status: 'running',
        },
        {
          runId: secondChild,
          nodeId: 'send-receipt',
          invocationKey: 'send-receipt:1',
          status: 'outcome_unknown',
        },
      ],
    };
    const run = fixtureRun(runId, 'failed');
    installRun({ run, nodes, callFamily });
    const { queryClient } = renderApp(`/w/${workspaceId}/runs/${runId}`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole(
        'button',
        { name: /^Send receipt · 1: Succeeded/u },
        coldStart,
      ),
    );
    const lens = screen.getByRole('complementary', { name: 'Step details' });
    expect(
      within(lens).getByRole('link', { name: 'Run ffff…ffff' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/runs/${firstChild}`);
    expect(within(lens).getByText('Running')).toBeVisible();
    expect(
      within(lens).queryByRole('link', { name: 'Run 5555…5555' }),
    ).not.toBeInTheDocument();
    await event.click(
      screen.getByRole('button', { name: /^Send receipt · 2: Failed/u }),
    );
    expect(
      within(lens).getByRole('link', { name: 'Run 5555…5555' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/runs/${secondChild}`);
    expect(within(lens).getByText('Outcome unknown')).toBeVisible();
    expect(
      within(lens).queryByRole('link', { name: 'Run ffff…ffff' }),
    ).not.toBeInTheDocument();
    mockServer.use(
      http.get(`${apiBase}/runs/${runId}`, () =>
        HttpResponse.json({
          run,
          nodes,
          callFamily: {
            ...callFamily,
            children: callFamily.children.map((child) => ({
              ...child,
              status: 'succeeded',
            })),
          },
        }),
      ),
    );
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: workflowRunKeys.detail(fixtureIds.user, workspaceId, runId),
      });
    });
    await waitFor(() =>
      expect(
        within(lens).queryByText('Outcome unknown'),
      ).not.toBeInTheDocument(),
    );
    expect(within(lens).getByText('Succeeded')).toBeVisible();
    mockServer.use(
      http.get(`${apiBase}/runs/${runId}`, () =>
        HttpResponse.json(
          {
            type: 'https://api.pertexo.test/problems/resource.not_found',
            title: 'Unavailable',
            status: 403,
            code: 'resource.not_found',
            requestId: 'selected-call-denied',
          },
          {
            status: 403,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
      ),
    );
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: workflowRunKeys.detail(fixtureIds.user, workspaceId, runId),
      });
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('link', { name: 'Run 5555…5555' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      queryClient.getQueryData(
        workflowRunKeys.detail(fixtureIds.user, workspaceId, runId),
      ),
    ).toBeUndefined();
  });

  it.each([
    'missing family',
    'no accepted child',
    'different node',
    'different invocation',
    'unstarted invocation',
  ] as const)('does not invent a selected child for %s', async (scenario) => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: query === '(min-width: 48rem)',
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    const callFamily: NonNullable<WorkflowRunResponse['callFamily']> = {
      rootRunId: runId,
      parentRunId: null,
      parentInvocationKey: null,
      children:
        scenario === 'no accepted child'
          ? []
          : [
              {
                runId: fixtureIds.secondRun,
                nodeId:
                  scenario === 'different node' ? 'other-step' : 'send-receipt',
                invocationKey:
                  scenario === 'different invocation'
                    ? 'send-receipt:1'
                    : 'send-receipt:0',
                status: 'succeeded',
              },
            ],
    };
    installRun({
      run: fixtureRun(runId, 'succeeded'),
      nodes:
        scenario === 'unstarted invocation'
          ? []
          : [node('succeeded', { completedAt: secondsAgo(30) })],
      callFamily: scenario === 'missing family' ? undefined : callFamily,
    });
    renderApp(`/w/${workspaceId}/runs/${runId}`);
    await userEvent
      .setup()
      .click(
        await screen.findByRole(
          'button',
          { name: /^Send receipt:/u },
          coldStart,
        ),
      );
    const lens = screen.getByRole('complementary', { name: 'Step details' });
    expect(
      within(lens).queryByRole('heading', { name: 'Called run' }),
    ).not.toBeInTheDocument();
    expect(
      within(lens).queryByRole('link', { name: 'Run ffff…ffff' }),
    ).not.toBeInTheDocument();
  });

  it('navigates accepted child and parent run links through the existing detail route', async () => {
    const childId = fixtureIds.secondRun;
    const parent = fixtureRun(runId, 'succeeded');
    const child = fixtureRun(childId, 'succeeded', {
      triggerType: 'workflow_call',
    });
    installRun({ run: parent, nodes: [] });
    mockServer.use(
      http.get(`${apiBase}/runs/${runId}`, () =>
        HttpResponse.json({
          run: parent,
          nodes: [],
          callFamily: {
            rootRunId: runId,
            parentRunId: null,
            parentInvocationKey: null,
            children: [
              {
                runId: childId,
                nodeId: 'call-child',
                invocationKey: 'call-child:0',
                status: 'succeeded',
              },
            ],
          },
        }),
      ),
      http.get(`${apiBase}/runs/${childId}`, () =>
        HttpResponse.json({
          run: child,
          nodes: [],
          callFamily: {
            rootRunId: runId,
            parentRunId: runId,
            parentInvocationKey: 'call-child:0',
            children: [],
          },
        }),
      ),
      http.get(
        `${apiBase}/runs/${childId}/events`,
        () =>
          new HttpResponse('', {
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    );
    const { router } = renderApp(`/w/${workspaceId}/runs/${runId}`);
    const link = await screen.findByRole(
      'link',
      { name: 'call-child: run ffff…ffff' },
      coldStart,
    );
    expect(link).toHaveAttribute('href', `/w/${workspaceId}/runs/${childId}`);
    await userEvent.setup().click(link);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${childId}`,
      );
    });
    const parentLink = await screen.findByRole('link', {
      name: 'Parent run eeee…eeee',
    });
    expect(parentLink).toHaveAttribute(
      'href',
      `/w/${workspaceId}/runs/${runId}`,
    );
    await userEvent.setup().click(parentLink);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${runId}`,
      );
    });
  });
  it('updates the visible run and step status when a waiting run resumes', async () => {
    installRun({ run: fixtureRun(runId, 'waiting'), nodes: [node('waiting')] });
    let status: 'waiting' | 'running' = 'waiting';
    mockServer.use(
      http.get(`${apiBase}/run-statistics`, () =>
        HttpResponse.json(fixtureStatistics()),
      ),
      http.get(`${apiBase}/runs/${runId}`, () =>
        HttpResponse.json({
          run: fixtureRun(runId, status),
          nodes: [node(status)],
        }),
      ),
    );
    const { queryClient } = renderApp(`/w/${workspaceId}/runs/${runId}`);
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Send receipt is waiting',
      }),
    ).toBeVisible();
    status = 'running';
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: workflowRunKeys.detail(fixtureIds.user, workspaceId, runId),
      });
    });
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Running Send receipt',
      }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: /^Send receipt: Running/u }),
    ).toBeVisible();
  });

  it('puts a failure first and the actions at thumb height on phones', async () => {
    emulatePhoneScreen();
    installRun({
      run: fixtureRun(runId, 'failed'),
      nodes: [
        node('failed', {
          currentAttemptNumber: 3,
          completedAt: secondsAgo(5),
          safeErrorCode: 'provider.unavailable',
        }),
      ],
    });
    renderApp(`/w/${workspaceId}/runs/${runId}`);
    expect(
      await screen.findByRole(
        'region',
        { name: 'Why Send receipt failed' },
        coldStart,
      ),
    ).toHaveTextContent(
      'The service this step calls was unavailable, so the step didn’t finish.',
    );
    const steps = screen.getByRole('region', { name: 'Steps' });
    expect(
      within(steps).getByRole('button', {
        name: 'Send receipt: Failed, 3 attempts',
      }),
    ).toBeVisible();
    const actions = screen.getByRole('group', { name: 'Run actions' });
    expect(
      within(actions).getByRole('link', { name: 'Open workflow' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/workflows/${workflowId}`);
  });

  it('keeps a running run’s phone actions to what fits, with the workflow a tap away above', async () => {
    emulatePhoneScreen();
    installRun({ run: retryingRun(), nodes: [node('running')] });
    // Someone who can both replay and cancel: the crowded case.
    mockServer.use(...identityHandlers([...capabilities, 'run:replay']));
    renderApp(`/w/${workspaceId}/runs/${runId}`);
    const actions = await screen.findByRole(
      'group',
      { name: 'Run actions' },
      coldStart,
    );
    expect(
      within(actions)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Replay', 'Cancel run']);
    expect(
      within(actions).queryByRole('link', { name: 'Open workflow' }),
    ).not.toBeInTheDocument();
    for (const link of screen.getAllByRole('link', {
      name: 'Customer onboarding',
    }))
      expect(link).toHaveAttribute(
        'href',
        `/w/${workspaceId}/workflows/${workflowId}`,
      );
  });

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

  it('traces the breadcrumb back through Runs and the run’s workflow', async () => {
    installRun({
      run: retryingRun(),
      nodes: [node('waiting', { resumeAt: secondsAgo(-60) })],
      events: retryEvents(),
    });
    renderApp(`/w/${workspaceId}/runs/${runId}`);
    const trail = await screen.findByRole(
      'navigation',
      { name: 'Breadcrumb' },
      coldStart,
    );
    expect(
      await within(trail).findByRole('link', { name: 'Runs' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/runs`);
    expect(
      within(trail).getByRole('link', { name: 'Customer onboarding' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/workflows/${workflowId}`);
    expect(within(trail).getByText('eeee…eeee')).toBeVisible();
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
      name: 'Cancel this run?',
    });
    expect(
      within(dialog).getByText(/Steps that already finished aren’t undone./u),
    ).toBeVisible();
    expect(cancels).toBe(0);
    await event.click(
      within(dialog).getByRole('button', { name: 'Cancel run' }),
    );
    expect(await screen.findByText('Canceling the run')).toBeVisible();
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

  it('shows the run input and a step’s file in its Data out', async () => {
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
      input: { kind: 'inline', value: { orderId: 'A-17' } },
      output: { kind: 'artifact', artifactId },
    });
    renderApp(`/w/${workspaceId}/runs/${runId}`);
    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: 'Succeeded in 2s' },
        coldStart,
      ),
    ).toBeVisible();

    // The only step's input came from the run's; with nothing recorded, it
    // shows as source data. It returned a file.
    const lens = screen.getByRole('complementary', { name: 'Step details' });
    const sources = await within(lens).findByRole('region', {
      name: 'Where it came from',
    });
    const runInput = await within(sources).findByRole('group', {
      name: 'Run input',
    });
    expect(await within(runInput).findByText(/A-17/u)).toBeVisible();
    expect(await within(lens).findByText('CSV file')).toBeVisible();

    await userEvent
      .setup()
      .click(screen.getByRole('tab', { name: 'Input & output' }));
    const panel = screen.getByRole('tabpanel');
    expect(
      await within(panel).findByRole('group', { name: 'Run input' }),
    ).toHaveTextContent(/orderId/u);
    expect(
      within(panel).getByRole('button', { name: /Send receipt/u }),
    ).toHaveTextContent('file');
  });
});
