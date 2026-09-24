import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NotificationsProvider } from '@/components/ui/toast';
import { NodeTestPanel } from '@/features/workflow-publish/public';
import { ApiError } from '@/lib/api/api-error';
import type { ApiClient, ApiJsonRequest } from '@/lib/api/client';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const previewId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

describe('node test panel', () => {
  it('resets input, check, result and acknowledgement when the step changes', async () => {
    let resolveValidation: ((value: unknown) => void) | undefined;
    const validation = new Promise((resolve) => {
      resolveValidation = resolve;
    });
    const apiClient = apiClientFor(() => validation);
    const event = userEvent.setup();
    const view = render(panel(apiClient, 'node-a'));

    fireEvent.change(screen.getByLabelText('Sample input (JSON)'), {
      target: { value: '{"a":1}' },
    });
    await event.click(
      screen.getByRole('switch', {
        name: 'I understand this test runs for real',
      }),
    );
    await event.click(screen.getByRole('button', { name: 'Check setup' }));

    view.rerender(panel(apiClient, 'node-b'));
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
    render(panel(apiClient, 'node-a', 'This sends a real Slack message.'));
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
    render(panel(apiClient, 'node-a', undefined, onSucceeded));
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
    render(panel(apiClient, 'node-a'));
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

function panel(
  apiClient: ApiClient,
  nodeId: string,
  stepSideEffect?: string,
  onSucceeded?: () => void,
): ReactNode {
  return (
    <NotificationsProvider>
      <NodeTestPanel
        key={nodeId}
        apiClient={apiClient}
        workspaceId={workspaceId}
        workflowId={workflowId}
        nodeId={nodeId}
        stepSideEffect={stepSideEffect}
        priorPreview={undefined}
        ensureSaved={() => Promise.resolve({ revision: 1 })}
        {...(onSucceeded === undefined ? {} : { onSucceeded })}
      />
    </NotificationsProvider>
  );
}

function apiClientFor(
  request: (input: ApiJsonRequest<unknown>) => Promise<unknown>,
): ApiClient {
  return {
    request,
    stream: vi.fn(),
  } as unknown as ApiClient;
}
