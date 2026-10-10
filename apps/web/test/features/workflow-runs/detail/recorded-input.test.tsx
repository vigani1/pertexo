import type { AccessibleWorkspace } from '@pertexo/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { NotificationsProvider } from '@/components/ui/toast';
import { StepInputData } from '@/features/workflow-runs/components/run-detail/data';
import { describeNodeStatus } from '@/features/workflow-runs/model/run-status';
import type {
  RunTimelineRow,
  RunTimelineStepStatus,
} from '@/features/workflow-runs/model/timeline/runs';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../../support/mock-server';
import { testFetch } from '../../../support/render-app';
import {
  apiBase,
  fixtureIds,
  fixtureWorkspace,
} from '../../../support/fixtures/run';

const { user: userId, firstRun: runId } = fixtureIds;
const fetchRunId = '33333333-3333-4333-8333-333333333333';
const sendRunId = '44444444-4444-4444-8444-444444444444';
const scope = {
  apiClient: createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  }),
  userId,
  workspace: fixtureWorkspace([
    'workspace:read',
    'run:read',
    'artifact:read',
  ]) as AccessibleWorkspace,
  runId,
};

function row(
  nodeRunId: string,
  nodeId: string,
  label: string,
  status: RunTimelineStepStatus,
  currentAttemptNumber = 1,
): RunTimelineRow {
  const look =
    status === 'not_started'
      ? { tone: 'queued' as const, label: 'Not started yet' }
      : describeNodeStatus(status);
  return {
    key: nodeId,
    nodeId,
    nodeRunId,
    label,
    status,
    tone: look.tone,
    statusLabel: look.label,
    attempts: currentAttemptNumber,
    currentAttemptNumber,
    segments: [],
    story: [],
    outputs: [],
  };
}

const fetchOrder = row(fetchRunId, 'fetch-order', 'Fetch order', 'succeeded');
const upstream = new Map([
  ['fetch-order', []],
  ['send-receipt', ['fetch-order']],
]);

/** Serves the recorded input from `respond`, and Fetch order's output. */
function serve(respond: () => Response) {
  let reads = 0;
  mockServer.use(
    http.get(`${apiBase}/runs/${runId}/node-runs/${sendRunId}/input`, () => {
      reads += 1;
      return respond();
    }),
    http.get(`${apiBase}/runs/${runId}/node-runs/${fetchRunId}/output`, () =>
      HttpResponse.json({ output: { kind: 'inline', value: { total: 42 } } }),
    ),
  );
  return { reads: () => reads };
}

const recorded = (value: unknown) =>
  HttpResponse.json({ input: { kind: 'inline', value } });
const none = () => HttpResponse.json({ input: { kind: 'none' } });

/** Renders Send receipt's Data in; `show` hands it the row a later snapshot has. */
function renderStep(initial: RunTimelineRow) {
  const queryClient = createQueryClient();
  const view = (current: RunTimelineRow) => (
    <QueryClientProvider client={queryClient}>
      <NotificationsProvider>
        <StepInputData
          row={current}
          rows={[fetchOrder, current]}
          upstream={upstream}
          scope={scope}
        />
      </NotificationsProvider>
    </QueryClientProvider>
  );
  const result = render(view(initial));
  return {
    show: (next: RunTimelineRow) => {
      result.rerender(view(next));
    },
  };
}

const dataIn = () =>
  screen.findByRole(
    'group',
    { name: 'Data in of Send receipt' },
    {
      timeout: 4_000,
    },
  );

describe('recorded step input', () => {
  it.each([false, true])(
    'does not claim skipped steps received input (uses connection: %s)',
    async (usesConnection) => {
      const server = serve(() => recorded({ never: 'read' }));
      renderStep({
        ...row(sendRunId, 'send-receipt', 'Send receipt', 'skipped', 0),
        usesConnection,
      });
      expect(
        await screen.findByText(
          'This step was skipped, so it received no input.',
        ),
      ).toBeVisible();
      expect(server.reads()).toBe(0);
      expect(
        screen.queryByRole('region', { name: 'Where it came from' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Pertexo didn’t keep exactly/u),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/this step sends it through a connection/u),
      ).not.toBeInTheDocument();
    },
  );

  it.each([500, 403])(
    'stops polling and offers recovery after an empty read then HTTP %s',
    async (status) => {
      let calls = 0;
      let recovered = false;
      const server = serve(() => {
        calls += 1;
        if (recovered) return recorded({ recovered: true });
        return calls === 1
          ? none()
          : HttpResponse.json(
              { code: 'internal', message: 'Unavailable' },
              { status },
            );
      });
      renderStep(row(sendRunId, 'send-receipt', 'Send receipt', 'running'));
      expect(await screen.findByText('Not recorded yet.')).toBeVisible();
      const problem = await screen.findByRole('alert', {}, { timeout: 3_000 });
      expect(problem).toHaveTextContent(
        'Couldn’t load exactly what this step received.',
      );
      expect(screen.queryByText('Not recorded yet.')).not.toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(server.reads()).toBe(2);
      recovered = true;
      await userEvent
        .setup()
        .click(within(problem).getByRole('button', { name: 'Try again' }));
      expect(await dataIn()).toHaveTextContent(/recovered: true/u);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    },
  );

  it('stops after five empty reads instead of polling indefinitely', async () => {
    const server = serve(none);
    renderStep(row(sendRunId, 'send-receipt', 'Send receipt', 'running'));
    expect(await screen.findByText('Not recorded yet.')).toBeVisible();
    // Reads occur immediately, then after 1, 2, 4 and 8 seconds.
    await new Promise((resolve) => setTimeout(resolve, 18_000));
    expect(server.reads()).toBe(5);
  }, 25_000);

  it('reads again when a running step records its input after the first read', async () => {
    let calls = 0;
    serve(() => {
      calls += 1;
      return calls === 1 ? none() : recorded({ attempt: 1 });
    });
    renderStep(row(sendRunId, 'send-receipt', 'Send receipt', 'running'));
    expect(await screen.findByText('Not recorded yet.')).toBeVisible();
    expect(await dataIn()).toHaveTextContent(/attempt: 1/u);
  });

  it('never shows an earlier attempt’s input for a retry, even with the same status', async () => {
    let serverAttempt = 1;
    let recordedYet = true;
    serve(() => (recordedYet ? recorded({ attempt: serverAttempt }) : none()));
    const step = renderStep(
      row(sendRunId, 'send-receipt', 'Send receipt', 'running'),
    );
    expect(await dataIn()).toHaveTextContent(/attempt: 1/u);

    // Attempt 2 is admitted: the database clears attempt 1's input, and the
    // step shows running again before attempt 2 records its own.
    serverAttempt = 2;
    recordedYet = false;
    step.show(row(sendRunId, 'send-receipt', 'Send receipt', 'running', 2));
    expect(await screen.findByText('Not recorded yet.')).toBeVisible();
    expect(
      screen.queryByRole('group', { name: 'Data in of Send receipt' }),
    ).not.toBeInTheDocument();

    recordedYet = true;
    expect(await dataIn()).toHaveTextContent(/attempt: 2/u);
  });

  it('keeps a finished step’s recorded input without reading it again', async () => {
    const server = serve(() => recorded({ attempt: 1 }));
    renderStep(row(sendRunId, 'send-receipt', 'Send receipt', 'succeeded'));
    expect(await dataIn()).toHaveTextContent(/attempt: 1/u);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(server.reads()).toBe(1);
  });

  it('says when the input couldn’t load, offers a retry, and labels the sources', async () => {
    let fail = true;
    serve(() =>
      fail
        ? HttpResponse.json(
            { code: 'internal', message: 'Something went wrong.' },
            { status: 500 },
          )
        : recorded({ amount: 42 }),
    );
    renderStep(row(sendRunId, 'send-receipt', 'Send receipt', 'succeeded'));
    const problem = await screen.findByRole('alert');
    expect(problem).toHaveTextContent(
      'Couldn’t load exactly what this step received.',
    );
    // What the steps before it returned stays available, named for what it is.
    const sources = screen.getByRole('region', { name: 'Where it came from' });
    expect(sources).toHaveTextContent(/not the exact input/u);
    expect(
      await within(sources).findByRole('group', {
        name: 'Data out of Fetch order',
      }),
    ).toHaveTextContent(/total: 42/u);

    fail = false;
    await userEvent
      .setup()
      .click(within(problem).getByRole('button', { name: 'Try again' }));
    expect(await dataIn()).toHaveTextContent(/amount: 42/u);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says a step that uses a connection doesn’t keep its input, without asking', async () => {
    const server = serve(() => recorded({ never: 'read' }));
    renderStep({
      ...row(sendRunId, 'send-receipt', 'Send receipt', 'succeeded'),
      usesConnection: true,
    });
    expect(
      await screen.findByText(
        'Not kept: this step sends it through a connection, and Pertexo doesn’t store what steps send.',
      ),
    ).toBeVisible();
    expect(
      await within(
        screen.getByRole('region', { name: 'Where it came from' }),
      ).findByRole('group', { name: 'Data out of Fetch order' }),
    ).toHaveTextContent(/total: 42/u);
    expect(server.reads()).toBe(0);
  });

  it.each([
    [
      'none',
      'Pertexo didn’t keep exactly what this step received, for example because it was over 256 KB.',
    ],
    ['expired', 'No longer kept. Pertexo keeps run data for 30 days.'],
  ])(
    'says why a finished step has no recorded input (%s)',
    async (kind, why) => {
      serve(() => HttpResponse.json({ input: { kind } }));
      renderStep(row(sendRunId, 'send-receipt', 'Send receipt', 'failed'));
      expect(await screen.findByText(why)).toBeVisible();
      expect(
        screen.getByRole('region', { name: 'Where it came from' }),
      ).toHaveTextContent(/not the exact input/u);
    },
  );
});
