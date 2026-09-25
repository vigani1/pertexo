import { QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { useRunFailures } from '@/features/overview/use-run-failures';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../support/mock-server';
import { renderApp, testFetch } from '../support/render-app';
import {
  apiBase,
  coldStart,
  emptyGraph,
  fixtureIds,
  fixtureRun,
  fixtureVersion,
  fixtureWorkflow,
  fixtureWorkspace,
  identityHandlers,
  minutesAgo,
  statisticsHandler,
} from '../support/run-fixtures';

const { workspace: workspaceId, workflow: workflowId } = fixtureIds;
const failedRunId = fixtureIds.secondRun;
const capabilities = ['workspace:read', 'workflow:read', 'run:read'];

const graph = {
  ...emptyGraph,
  nodes: [
    {
      id: 'send-receipt',
      label: 'Send receipt',
      definition: { key: 'email.send_notification', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    },
  ],
};

function failedRun() {
  return fixtureRun(failedRunId, 'failed', {
    workflowName: 'Daily intake',
    createdAt: minutesAgo(30),
    updatedAt: minutesAgo(30),
    startedAt: minutesAgo(30),
    completedAt: minutesAgo(29),
  });
}

function homeReads() {
  return [
    ...identityHandlers(capabilities),
    statisticsHandler(),
    http.get(`${apiBase}/runs`, ({ request }) =>
      HttpResponse.json({
        items:
          new URL(request.url).searchParams.get('status') === 'failed'
            ? [failedRun()]
            : [],
        nextCursor: null,
      }),
    ),
    http.get(`${apiBase}/runs/${failedRunId}`, () =>
      HttpResponse.json({
        run: failedRun(),
        nodes: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            nodeId: 'send-receipt',
            invocationKey: 'send-receipt:0',
            status: 'failed',
            currentAttemptNumber: 3,
            startedAt: minutesAgo(30),
            completedAt: minutesAgo(29),
            resumeAt: null,
            safeErrorCode: 'provider.unavailable',
          },
        ],
      }),
    ),
    http.get(`${apiBase}/workflows`, () =>
      HttpResponse.json({
        items: [fixtureWorkflow({ name: 'Daily intake' })],
        nextCursor: null,
      }),
    ),
    http.get(`${apiBase}/workflows/${workflowId}/versions`, () =>
      HttpResponse.json({ items: [fixtureVersion(graph)], nextCursor: null }),
    ),
    http.get(`${apiBase}/workflows/${workflowId}/draft`, () =>
      HttpResponse.json(
        {
          workflowId,
          revision: 1,
          schemaVersion: 1,
          graph,
          compatibility: {
            compatible: true,
            fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
            issues: [],
          },
          updatedAt: minutesAgo(40),
        },
        { headers: { etag: `"draft-v1.${'a'.repeat(43)}"` } },
      ),
    ),
  ];
}

describe('home details', () => {
  it('names where and why the latest failed run stopped', async () => {
    mockServer.use(...homeReads());
    renderApp(`/w/${workspaceId}`);
    const attention = await screen.findByRole(
      'region',
      { name: 'Needs attention' },
      coldStart,
    );
    expect(
      await within(attention).findByText(
        /^Send receipt · service unavailable · latest/u,
      ),
    ).toBeVisible();
  });

  it('shows each recently changed workflow’s shape and live version', async () => {
    mockServer.use(...homeReads());
    renderApp(`/w/${workspaceId}`);
    const recent = await screen.findByRole(
      'region',
      { name: 'Recently changed' },
      coldStart,
    );
    expect(await within(recent).findByText(/^v7 · published /u)).toBeVisible();
    expect(
      recent.querySelector('[data-slot="pattern-glyph"]'),
    ).toBeInTheDocument();
  });
});

describe('home run failures', () => {
  it('reads a version once for every failed run that ran it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let versionReads = 0;
    const runs = [fixtureIds.firstRun, fixtureIds.secondRun];
    mockServer.use(
      ...runs.map((runId) =>
        http.get(`${apiBase}/runs/${runId}`, () =>
          HttpResponse.json({
            run: fixtureRun(runId, 'failed'),
            nodes: [],
          }),
        ),
      ),
      http.get(`${apiBase}/workflows/${workflowId}/versions`, () => {
        versionReads += 1;
        return HttpResponse.json({
          items: [fixtureVersion(graph)],
          nextCursor: null,
        });
      }),
    );
    const queryClient = createQueryClient();
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    });
    const { result } = renderHook(
      () =>
        useRunFailures({
          apiClient,
          userId: fixtureIds.user,
          workspace: fixtureWorkspace(capabilities) as Parameters<
            typeof useRunFailures
          >[0]['workspace'],
          runIds: runs,
        }),
      {
        wrapper: ({ children }: Readonly<{ children: ReactNode }>) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      },
    );
    await waitFor(() => {
      expect(result.current.size).toBe(2);
    });
    await waitFor(() => {
      expect(versionReads).toBe(1);
    });
    expect(
      warn.mock.calls.some(([message]) =>
        String(message).includes('Duplicate Queries'),
      ),
    ).toBe(false);
    warn.mockRestore();
  });
});
