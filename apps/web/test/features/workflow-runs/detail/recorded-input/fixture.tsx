import { createQueryClient } from '@/app/query-client';
import { NotificationsProvider } from '@/components/ui/toast';
import { StepInputData } from '@/features/workflow-runs/components/run-detail/data/inputs';
import { describeNodeStatus } from '@/features/workflow-runs/model/presentation/run-status';
import type {
  RunTimelineRow,
  RunTimelineStepStatus,
} from '@/features/workflow-runs/model/timeline/runs';
import { createApiClient } from '@/lib/api/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import {
  apiBase,
  fixtureIds,
  fixtureWorkspace,
} from '../../../../support/fixtures/run';
import { mockServer } from '../../../../support/mock-server';
import { testFetch } from '../../../../support/render-app';
export const { user: userId, firstRun: runId } = fixtureIds;

const fetchRunId = '33333333-3333-4333-8333-333333333333';

export const sendRunId = '44444444-4444-4444-8444-444444444444';

const scope = {
  apiClient: createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  }),
  userId,
  workspace: fixtureWorkspace(['workspace:read', 'run:read', 'artifact:read']),
  runId,
};

export function row({
  nodeRunId,
  nodeId,
  label,
  status,
  currentAttemptNumber = 1,
}: Readonly<{
  nodeRunId: string;
  nodeId: string;
  label: string;
  status: RunTimelineStepStatus;
  currentAttemptNumber?: number;
}>): RunTimelineRow {
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

const fetchOrder = row({
  nodeRunId: fetchRunId,
  nodeId: 'fetch-order',
  label: 'Fetch order',
  status: 'succeeded',
});

const upstream = new Map([
  ['fetch-order', []],
  ['send-receipt', ['fetch-order']],
]);

export function serve(respond: () => Response) {
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

export const recorded = (value: unknown) =>
  HttpResponse.json({ input: { kind: 'inline', value } });

export const none = () => HttpResponse.json({ input: { kind: 'none' } });

export function renderStep(initial: RunTimelineRow) {
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

export const dataIn = () =>
  screen.findByRole(
    'group',
    { name: 'Data in of Send receipt' },
    {
      timeout: 4_000,
    },
  );

export function failAfterEmptyRead(status: number) {
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
  return {
    server,
    recover: () => {
      recovered = true;
    },
  };
}
