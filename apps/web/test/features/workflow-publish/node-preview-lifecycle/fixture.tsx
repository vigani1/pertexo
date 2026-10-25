import { NotificationsProvider } from '@/components/ui/toast';
import { NodeTestPanel } from '@/features/workflow-publish/public';
import type { ApiClient, ApiJsonRequest } from '@/lib/api/client';
import { stepSampleResponseSchema } from '@pertexo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const previewId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export const disclosure = {
  sideEffectClass: 'safe',
  mayContactProvider: false,
  mayCauseExternalSideEffect: false,
  dryRun: 'not_supported',
} as const;

export function previewSummary(status: 'running' | 'succeeded') {
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

export function panel({
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

export function apiClientFor(
  request: (input: ApiJsonRequest<unknown>) => Promise<unknown>,
  sample: () => unknown = () => ({
    sample: null,
    output: null,
    draftRevision: 1,
    limits: { inlineBytes: 262144, depth: 64, members: 10000 },
  }),
): ApiClient {
  return /* This endpoint dispatcher supplies specific decoded responses; the generic ApiClient request signature cannot express its finite fixture responses. */ {
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

export const sampleId = '11111111-1111-4111-8111-111111111111';

export function sampleResponse(state: 'pinned' | 'stale' | 'expired'): {
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
