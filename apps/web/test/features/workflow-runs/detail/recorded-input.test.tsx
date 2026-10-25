import { act, screen, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse } from 'msw';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dataIn,
  failAfterEmptyRead,
  none,
  recorded,
  renderStep,
  row,
  sendRunId,
  serve,
} from './recorded-input/fixture';

afterEach(() => {
  vi.useRealTimers();
});

describe('recorded step input', () => {
  it.each([false, true])(
    'does not claim skipped steps received input (uses connection: %s)',
    async (usesConnection) => {
      const server = serve(() => recorded({ never: 'read' }));
      renderStep({
        ...row({
          nodeRunId: sendRunId,
          nodeId: 'send-receipt',
          label: 'Send receipt',
          status: 'skipped',
          currentAttemptNumber: 0,
        }),
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
  it('keeps the empty answer, stops polling and offers Retry after an HTTP 500 refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { server, recover } = failAfterEmptyRead(500);
    renderStep(
      row({
        nodeRunId: sendRunId,
        nodeId: 'send-receipt',
        label: 'Send receipt',
        status: 'running',
      }),
    );
    expect(await screen.findByText('Not recorded yet.')).toBeVisible();
    const problem = await screen.findByRole('alert', {}, { timeout: 3_000 });
    expect(problem).toHaveTextContent(/Couldn’t refresh/u);
    expect(screen.getByText('Not recorded yet.')).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(server.reads()).toBe(2);
    recover();
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(within(problem).getByRole('button', { name: 'Retry' }));
    expect(await dataIn()).toHaveTextContent(/recovered: true/u);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('hides the empty answer, stops polling and offers recovery after an HTTP 403 refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { server, recover } = failAfterEmptyRead(403);
    renderStep(
      row({
        nodeRunId: sendRunId,
        nodeId: 'send-receipt',
        label: 'Send receipt',
        status: 'running',
      }),
    );
    expect(await screen.findByText('Not recorded yet.')).toBeVisible();
    const problem = await screen.findByRole('alert', {}, { timeout: 3_000 });
    expect(problem).toHaveTextContent(
      'Couldn’t load exactly what this step received.',
    );
    expect(screen.queryByText('Not recorded yet.')).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(server.reads()).toBe(2);
    recover();
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(within(problem).getByRole('button', { name: 'Try again' }));
    expect(await dataIn()).toHaveTextContent(/recovered: true/u);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('stops after five empty reads instead of polling indefinitely', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = serve(none);
    renderStep(
      row({
        nodeRunId: sendRunId,
        nodeId: 'send-receipt',
        label: 'Send receipt',
        status: 'running',
      }),
    );
    expect(await screen.findByText('Not recorded yet.')).toBeVisible();
    // Advancing beyond the polling window also catches an unwanted sixth read.
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(server.reads()).toBe(5);
  }, 25_000);
  it('reads again when a running step records its input after the first read', async () => {
    let calls = 0;
    serve(() => {
      calls += 1;
      return calls === 1 ? none() : recorded({ attempt: 1 });
    });
    renderStep(
      row({
        nodeRunId: sendRunId,
        nodeId: 'send-receipt',
        label: 'Send receipt',
        status: 'running',
      }),
    );
    expect(await screen.findByText('Not recorded yet.')).toBeVisible();
    expect(await dataIn()).toHaveTextContent(/attempt: 1/u);
  });
  it('never shows an earlier attempt’s input for a retry, even with the same status', async () => {
    let serverAttempt = 1;
    let recordedYet = true;
    serve(() => (recordedYet ? recorded({ attempt: serverAttempt }) : none()));
    const step = renderStep(
      row({
        nodeRunId: sendRunId,
        nodeId: 'send-receipt',
        label: 'Send receipt',
        status: 'running',
      }),
    );
    expect(await dataIn()).toHaveTextContent(/attempt: 1/u);

    // Attempt 2 is admitted: the database clears attempt 1's input, and the
    // step shows running again before attempt 2 records its own.
    serverAttempt = 2;
    recordedYet = false;
    step.show(
      row({
        nodeRunId: sendRunId,
        nodeId: 'send-receipt',
        label: 'Send receipt',
        status: 'running',
        currentAttemptNumber: 2,
      }),
    );
    expect(await screen.findByText('Not recorded yet.')).toBeVisible();
    expect(
      screen.queryByRole('group', { name: 'Data in of Send receipt' }),
    ).not.toBeInTheDocument();

    recordedYet = true;
    expect(await dataIn()).toHaveTextContent(/attempt: 2/u);
  });
  it('keeps a finished step’s recorded input without reading it again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = serve(() => recorded({ attempt: 1 }));
    renderStep(
      row({
        nodeRunId: sendRunId,
        nodeId: 'send-receipt',
        label: 'Send receipt',
        status: 'succeeded',
      }),
    );
    expect(await dataIn()).toHaveTextContent(/attempt: 1/u);
    await act(() => vi.advanceTimersByTimeAsync(1_500));
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
    renderStep(
      row({
        nodeRunId: sendRunId,
        nodeId: 'send-receipt',
        label: 'Send receipt',
        status: 'succeeded',
      }),
    );
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
      ...row({
        nodeRunId: sendRunId,
        nodeId: 'send-receipt',
        label: 'Send receipt',
        status: 'succeeded',
      }),
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
      renderStep(
        row({
          nodeRunId: sendRunId,
          nodeId: 'send-receipt',
          label: 'Send receipt',
          status: 'failed',
        }),
      );
      expect(await screen.findByText(why)).toBeVisible();
      expect(
        screen.getByRole('region', { name: 'Where it came from' }),
      ).toHaveTextContent(/not the exact input/u);
    },
  );
});
