import { stepSampleResponseSchema } from '@pertexo/contracts';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NotificationsProvider } from '@/components/ui/toast';
import { NodeTestPanel } from '@/features/workflow-publish/public';
import { ApiError } from '@/lib/api/error';
import type { ApiClient, ApiJsonRequest } from '@/lib/api/client';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const previewId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

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

  it('resumes observation of an accepted test instead of running it again', async () => {
    let submissions = 0;
    let observations = 0;
    const apiClient = apiClientFor((request) => {
      if (request.path.includes('/draft/nodes/')) {
        submissions += 1;
        return Promise.resolve({
          mode: 'test_execute',
          replayed: false,
          preview: previewSummary('running'),
        });
      }
      observations += 1;
      if (observations === 1)
        return Promise.reject(
          new ApiError({ kind: 'network', message: 'stream unavailable' }),
        );
      return Promise.resolve({ preview: previewSummary('succeeded') });
    });
    render(panel({ apiClient, nodeId: 'node-a' }));
    const event = userEvent.setup();

    await event.click(
      screen.getByRole('switch', {
        name: 'I understand this test runs for real',
      }),
    );
    await event.click(screen.getByRole('button', { name: 'Run test' }));
    expect(
      await screen.findByRole('button', { name: 'Check test status' }),
    ).toBeVisible();
    expect(submissions).toBe(1);
    fireEvent.change(screen.getByLabelText('Sample input (JSON)'), {
      target: { value: '{\n}' },
    });
    expect(
      screen.getByRole('switch', {
        name: 'I understand this test runs for real',
      }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Check test status' }),
    ).toBeEnabled();

    await event.click(
      screen.getByRole('button', { name: 'Check test status' }),
    );
    await waitFor(() => {
      expect(screen.getByText('Test passed')).toBeVisible();
    });
    expect(submissions).toBe(1);
    expect(observations).toBe(2);
  }, 7_000);
});

const disclosure = {
  sideEffectClass: 'safe',
  mayContactProvider: false,
  mayCauseExternalSideEffect: false,
  dryRun: 'not_supported',
} as const;

function previewSummary(status: 'running' | 'succeeded') {
  return {
    id: previewId,
    workspaceId,
    workflowId,
    draftRevision: 1,
    nodeId: 'node-a',
    status,
    disclosure,
    output:
      status === 'succeeded'
        ? { kind: 'inline', value: { accepted: true } }
        : null,
    safeErrorCode: null,
    createdAt: '2026-09-15T10:00:00.000Z',
    startedAt: '2026-09-15T10:00:01.000Z',
    completedAt: status === 'succeeded' ? '2026-09-15T10:00:02.000Z' : null,
    expiresAt: '2026-09-15T11:00:00.000Z',
  };
}

function panel({
  apiClient,
  nodeId,
  stepSideEffect,
  onSucceeded,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
}: Readonly<{
  apiClient: ApiClient;
  nodeId: string;
  stepSideEffect?: string;
  onSucceeded?: () => void;
  client?: QueryClient;
}>): ReactNode {
  return (
    <QueryClientProvider client={client}>
      <NotificationsProvider>
        <NodeTestPanel
          key={nodeId}
          editable
          ensureSaved={() => Promise.resolve({ revision: 1 })}
          events={onSucceeded === undefined ? {} : { onSucceeded }}
          previews={{ priorPreview: undefined }}
          step={{ nodeId, stepSideEffect }}
          scope={{ apiClient, userId: 'owner', workspaceId, workflowId }}
        />
      </NotificationsProvider>
    </QueryClientProvider>
  );
}

function apiClientFor(
  request: (input: ApiJsonRequest<unknown>) => Promise<unknown>,
  sample: () => unknown = () => ({
    sample: null,
    output: null,
    draftRevision: 1,
    limits: { inlineBytes: 262144, depth: 64, members: 10000 },
  }),
): ApiClient {
  return {
    request: (input: ApiJsonRequest<unknown>) => {
      if (
        (input.path.endsWith('/sample') || input.path.endsWith('/samples')) &&
        (input.method === undefined || input.method === 'GET')
      ) {
        const response = stepSampleResponseSchema.parse(sample());
        return Promise.resolve(
          input.path.endsWith('/samples')
            ? {
                items: response.sample === null ? [] : [response.sample],
                draftRevision: response.draftRevision,
                limits: response.limits,
              }
            : response,
        );
      }
      return request(input);
    },
    stream: vi.fn(),
  } as unknown as ApiClient;
}

const sampleId = '11111111-1111-4111-8111-111111111111';
function sampleResponse(state: 'pinned' | 'stale' | 'expired'): {
  sample: {
    id: string;
    nodeId: string;
    binding: string;
    state: string;
    source: { kind: 'json' };
    createdAt: string;
    expiresAt: string;
  } | null;
  output: unknown;
  draftRevision: number;
  limits: { inlineBytes: number; depth: number; members: number };
} {
  return {
    sample: {
      id: sampleId,
      nodeId: 'node-a',
      binding: 'sample-binding',
      state,
      source: { kind: 'json' },
      createdAt: '2026-10-16T10:00:00.000Z',
      expiresAt: '2026-11-15T10:00:00.000Z',
    },
    output: { accepted: true },
    draftRevision: 1,
    limits: { inlineBytes: 262144, depth: 64, members: 10000 },
  };
}
