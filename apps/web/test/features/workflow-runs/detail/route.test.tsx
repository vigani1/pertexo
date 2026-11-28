import { workflowRunKeys } from '@/features/workflow-runs/data/query-cache';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import {
  apiBase,
  coldStart,
  fixtureIds,
  fixtureRun,
  fixtureStatistics,
  identityHandlers,
} from '../../../support/fixtures/run';
import { mockServer } from '../../../support/mock-server';
import { renderLoadedApp } from '../../../support/render-app';
import {
  artifactId,
  capabilities,
  emulatePhoneScreen,
  installRun,
  node,
  retryEvents,
  retryingRun,
  runId,
  secondsAgo,
  stepEvent,
  workflowId,
  workspaceId,
} from './route/fixture';

const STALLED_WORDING = /stalled/iu;

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('run page', () => {
  it('shows retained Call outcomes and child/parent links without linking expired child history', async () => {
    installRun({
      run: fixtureRun(runId, 'succeeded'),
      nodes: [node('succeeded', { completedAt: secondsAgo(5) })],
    });
    const call = {
      id: artifactId,
      invocationKey: 'send-receipt:0',
      targetWorkflowId: workflowId,
      targetVersionId: fixtureIds.version,
      childRunId: fixtureIds.secondRun,
      childHistory: 'retained',
      status: 'succeeded',
      slotLent: false,
      detailsRetired: false,
      safeErrorCode: null,
    };
    mockServer.use(
      http.get(`${apiBase}/runs/${runId}`, () =>
        HttpResponse.json({
          run: fixtureRun(runId, 'succeeded', { triggerType: 'workflow_call' }),
          nodes: [node('succeeded')],
          calls: [
            call,
            {
              ...call,
              id: fixtureIds.version,
              invocationKey: 'old:0',
              childHistory: 'expired',
              detailsRetired: true,
            },
          ],
          parentCall: {
            id: fixtureIds.workflow,
            parentRunId: fixtureIds.replayRun,
            invocationKey: 'parent:0',
          },
        }),
      ),
    );
    await renderLoadedApp(`/w/${workspaceId}/runs/${runId}`, { strict: true });
    const history = await screen.findByRole(
      'region',
      { name: 'Workflow Calls' },
      coldStart,
    );
    expect(
      within(history).getByRole('link', { name: 'Open child run' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/runs/${fixtureIds.secondRun}`);
    expect(
      within(history).getByRole('link', { name: 'Open parent run' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/runs/${fixtureIds.replayRun}`);
    expect(history).toHaveTextContent('Child history expired.');
    expect(history).toHaveTextContent('Call input and result details expired.');
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
    const { queryClient } = await renderLoadedApp(
      `/w/${workspaceId}/runs/${runId}`,
    );
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
    await renderLoadedApp(`/w/${workspaceId}/runs/${runId}`);
    expect(
      await screen.findByRole(
        'region',
        { name: 'Why Send receipt failed' },
        coldStart,
      ),
    ).toHaveTextContent(
      'The service this step calls was unavailable, so the step didn’t finish.',
    );
    const disclosure = screen.getByText(/^See all .* and the error$/u);
    const history = screen.getByRole('region', { name: 'Steps' });
    expect(history).not.toBeVisible();
    await userEvent.setup().click(disclosure);
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
    await renderLoadedApp(`/w/${workspaceId}/runs/${runId}`);
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
    // A healthy running run says nothing of stalling.
    expect(screen.queryByText(STALLED_WORDING)).toBeNull();
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
    await renderLoadedApp(`/w/${workspaceId}/runs/${runId}`);

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
    await renderLoadedApp(`/w/${workspaceId}/runs/${runId}`);
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
    await renderLoadedApp(`/w/${workspaceId}/runs/${runId}`);
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
    await renderLoadedApp(`/w/${workspaceId}/runs/${runId}`);
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
  // reliability-10: a stuck run reads "Running", as if its steps were progressing.
  it('says when a running run has stalled', async () => {
    installRun({
      run: fixtureRun(runId, 'running', {
        stalled: { since: secondsAgo(90) },
      }),
      nodes: [node('running')],
    });
    await renderLoadedApp(`/w/${workspaceId}/runs/${runId}`);
    expect(
      await screen.findByText(STALLED_WORDING, {}, coldStart),
    ).toBeVisible();
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
    await renderLoadedApp(`/w/${workspaceId}/runs/${runId}`);
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
