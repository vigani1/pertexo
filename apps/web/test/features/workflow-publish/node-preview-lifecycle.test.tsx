import { ApiError } from '@/lib/api/error';

import { QueryClient } from '@tanstack/react-query';

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { describe, expect, it, vi } from 'vitest';

import {
  apiClientFor,
  disclosure,
  panel,
  previewSummary,
  sampleId,
  sampleResponse,
} from './node-preview-lifecycle/fixture';

describe('node test panel', () => {
  it('tests pinned output without an effects acknowledgement or invented duration', async () => {
    const commands: unknown[] = [];
    const apiClient = apiClientFor(
      (input) => {
        commands.push(input.body);
        return Promise.resolve({
          mode: 'test_execute',
          replayed: false,
          preview: {
            ...previewSummary('succeeded'),
            pinnedSampleId: sampleId,
            startedAt: null,
          },
        });
      },
      () => sampleResponse('pinned'),
    );
    render(panel({ apiClient, nodeId: 'node-a' }));
    const run = await screen.findByRole('button', {
      name: 'Test with pinned output',
    });
    expect(run).toBeEnabled();
    expect(
      screen.queryByRole('switch', {
        name: 'I understand this test runs for real',
      }),
    ).toBeNull();
    await userEvent.setup().click(run);
    expect(
      await screen.findByRole('region', { name: 'Test result' }),
    ).toHaveTextContent('Pinned');
    expect(commands).toEqual([
      expect.objectContaining({
        expectedSampleId: sampleId,
        input: { kind: 'manual', value: {} },
      }),
    ]);
  });
  it.each(['stale', 'expired'] as const)(
    'blocks a %s pin instead of executing the real step',
    async (state) => {
      const execute = vi.fn();
      const apiClient = apiClientFor(execute, () => sampleResponse(state));
      render(panel({ apiClient, nodeId: 'node-a' }));
      await screen.findByText(
        state === 'stale' ? 'Pin needs review' : 'Pin expired',
      );
      await userEvent.setup().click(
        screen.getByRole('switch', {
          name: 'I understand this test runs for real',
        }),
      );
      expect(screen.getByRole('button', { name: 'Run test' })).toBeDisabled();
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('does not restore an old real-effects acknowledgement after a pin is added and removed', async () => {
    let current: unknown = {
      sample: null,
      output: null,
      draftRevision: 1,
      limits: { inlineBytes: 262144, depth: 64, members: 10000 },
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const execute = vi.fn();
    render(
      panel({
        apiClient: apiClientFor(execute, () => current),
        nodeId: 'node-a',
        client,
      }),
    );
    const event = userEvent.setup();
    await event.click(
      screen.getByRole('switch', {
        name: 'I understand this test runs for real',
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run test' })).toBeEnabled(),
    );
    current = sampleResponse('pinned');
    await act(() => client.invalidateQueries());
    expect(
      await screen.findByRole('button', { name: 'Test with pinned output' }),
    ).toBeEnabled();
    current = {
      sample: null,
      output: null,
      draftRevision: 1,
      limits: { inlineBytes: 262144, depth: 64, members: 10000 },
    };
    await act(() => client.invalidateQueries());
    expect(
      await screen.findByRole('switch', {
        name: 'I understand this test runs for real',
      }),
    ).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Run test' })).toBeDisabled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps the exact pinned test after a lost response even when the pin is removed', async () => {
    let current = sampleResponse('pinned');
    const sends: unknown[] = [];
    const apiClient = apiClientFor(
      (input) => {
        sends.push({ body: input.body, headers: input.headers });
        if (sends.length === 1)
          return Promise.reject(
            new ApiError({ kind: 'network', message: 'response lost' }),
          );
        return Promise.resolve({
          mode: 'test_execute',
          replayed: true,
          preview: {
            ...previewSummary('succeeded'),
            pinnedSampleId: sampleId,
            startedAt: null,
          },
        });
      },
      () => current,
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      panel({
        apiClient,
        nodeId: 'node-a',
        client,
      }),
    );
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Test with pinned output' }),
    );
    const retry = await screen.findByRole('button', {
      name: 'Retry the same test',
    });
    current = { ...current, sample: null, output: null };
    await act(() => client.invalidateQueries());
    expect(retry).toBeEnabled();
    await event.click(retry);
    expect(
      await screen.findByRole('region', { name: 'Test result' }),
    ).toHaveTextContent('Pinned');
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
  });
  it('resets input, check, result and acknowledgement when the step changes', async () => {
    let resolveValidation: ((value: unknown) => void) | undefined;
    const validation = new Promise((resolve) => {
      resolveValidation = resolve;
    });
    const apiClient = apiClientFor(() => validation);
    const event = userEvent.setup();
    const view = render(panel({ apiClient, nodeId: 'node-a' }));

    fireEvent.change(screen.getByLabelText('Sample input (JSON)'), {
      target: { value: '{"a":1}' },
    });
    await event.click(
      screen.getByRole('switch', {
        name: 'I understand this test runs for real',
      }),
    );
    await event.click(screen.getByRole('button', { name: 'Check setup' }));

    view.rerender(panel({ apiClient, nodeId: 'node-b' }));
    expect(screen.getByLabelText('Sample input (JSON)')).toHaveValue('{}');
    expect(
      screen.getByRole('switch', {
        name: 'I understand this test runs for real',
      }),
    ).not.toBeChecked();

    await act(async () => {
      resolveValidation?.({
        mode: 'validate',
        valid: true,
        revision: 1,
        nodeId: 'node-a',
        issues: [],
        disclosure,
      });
      await Promise.resolve();
    });
    expect(screen.queryByText('Setup looks right')).not.toBeInTheDocument();
  });
  it('shows the setup check issues inline in plain words', async () => {
    const apiClient = apiClientFor(() =>
      Promise.resolve({
        mode: 'validate',
        valid: false,
        revision: 1,
        nodeId: 'node-a',
        issues: [
          {
            path: '$.config.channelId',
            code: 'invalid_config',
            message: 'channel is required',
          },
        ],
        disclosure: {
          ...disclosure,
          sideEffectClass: 'unsafe',
          mayCauseExternalSideEffect: true,
        },
      }),
    );
    render(
      panel({
        apiClient,
        nodeId: 'node-a',
        stepSideEffect: 'This sends a real Slack message.',
      }),
    );
    expect(screen.getByText('This sends a real Slack message.')).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Check setup' }));
    expect(await screen.findByText('1 thing to fix')).toBeVisible();
    expect(screen.getByText('Channel is required.')).toBeVisible();
  });
  it('shows inline output as a JSON tree after a passed test', async () => {
    const onSucceeded = vi.fn();
    const apiClient = apiClientFor(() =>
      Promise.resolve({
        mode: 'test_execute',
        replayed: false,
        preview: previewSummary('succeeded'),
      }),
    );
    render(
      panel({
        apiClient,
        nodeId: 'node-a',
        onSucceeded,
      }),
    );
    const event = userEvent.setup();
    expect(screen.getByRole('button', { name: 'Run test' })).toBeDisabled();
    await event.click(
      screen.getByRole('switch', {
        name: 'I understand this test runs for real',
      }),
    );
    await event.click(screen.getByRole('button', { name: 'Run test' }));
    expect(await screen.findByText('Test passed')).toBeVisible();
    expect(
      screen.getByRole('group', { name: 'Test output' }),
    ).toHaveTextContent('accepted');
    expect(onSucceeded).toHaveBeenCalledTimes(1);
  });
  it('says why the step refused its input', async () => {
    const apiClient = apiClientFor(() =>
      Promise.resolve({
        mode: 'test_execute',
        replayed: false,
        preview: {
          ...previewSummary('running'),
          status: 'failed',
          safeErrorCode: 'preview.input_invalid',
          errorSummary: 'Use a date like 2026-10-19.',
          completedAt: '2026-09-15T10:00:02.000Z',
        },
      }),
    );
    render(panel({ apiClient, nodeId: 'node-a' }));
    const event = userEvent.setup();
    await event.click(
      screen.getByRole('switch', {
        name: 'I understand this test runs for real',
      }),
    );
    await event.click(screen.getByRole('button', { name: 'Run test' }));
    expect(
      await screen.findByText('Use a date like 2026-10-19.'),
    ).toBeVisible();
    expect(
      screen.getByText(/The step reported: an input couldn’t be used/u),
    ).toBeVisible();
  });
});
