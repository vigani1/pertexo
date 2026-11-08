import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, expect, it } from 'vitest';
import {
  accessibleWorkspaceSchema,
  workflowSummarySchema,
} from '@pertexo/contracts';
import { WorkflowTestDialog } from '@/features/workflow-publish/components/workflow-tests/dialog';
import { useWorkflowTests } from '@/features/workflow-publish/hooks/use-workflow-tests';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import {
  api,
  userId,
  workspaceId,
  workflowId,
  workspaceWith,
  summary,
} from '../workflows/list/fixtures';

const pendingReads: (() => void)[] = [];
afterEach(() => {
  for (const release of pendingReads.splice(0)) release();
});

it('keeps input entered while a pinned trigger sample is loading until it is explicitly applied', async () => {
  const { event, release, sampleSettled, reads } = mountTriggerInput();
  await prepareAndLoad(event);
  const input = screen.getByRole('textbox', { name: 'Test input (JSON)' });
  await event.clear(input);
  await event.type(input, '{{"customer":"my new edit"}');
  await act(async () => {
    release();
    await sampleSettled;
  });
  expect(
    await screen.findByText(
      'The pinned sample is ready. Your edited input is kept.',
    ),
  ).toBeVisible();
  expect(input).toHaveValue('{"customer":"my new edit"}');
  await event.click(
    screen.getByRole('button', { name: 'Apply loaded sample' }),
  );
  expect(input).toHaveValue(JSON.stringify({ customer: 'old pin' }, null, 2));
  expect(reads()).toBe(1);
});

it('retires a pending sample when its dialog closes and keeps input on reopening', async () => {
  const { event, release, sampleSettled } = mountTriggerInput();
  await event.click(await screen.findByRole('button', { name: 'Prepare' }));
  const input = screen.getByRole('textbox', { name: 'Test input (JSON)' });
  await event.clear(input);
  await event.type(input, '{{"draft":true}');
  await event.click(
    await screen.findByRole('button', { name: 'Use trigger’s pinned sample' }),
  );
  await event.click(screen.getByRole('button', { name: 'Close' }));
  await event.click(screen.getByRole('button', { name: 'Prepare' }));
  const reopened = await screen.findByRole('textbox', {
    name: 'Test input (JSON)',
  });
  await act(async () => {
    release();
    await sampleSettled;
  });
  await waitFor(() => {
    expect(reopened).toHaveValue('{"draft":true}');
  });
  expect(screen.queryByText('Pinned sample loaded.')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Apply loaded sample' }),
  ).not.toBeInTheDocument();
});

it('shows progress, prevents competing loads and applies a sample when input has not changed', async () => {
  const { event, release, reads } = mountTriggerInput();
  await prepareAndLoad(event);
  const loading = screen.getByRole('button', {
    name: 'Loading pinned sample…',
  });
  expect(loading).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Start test' })).toBeDisabled();
  await event.dblClick(loading);
  release();
  expect(await screen.findByText('Pinned sample loaded.')).toBeVisible();
  expect(
    screen.getByRole('textbox', { name: 'Test input (JSON)' }),
  ).toHaveValue(JSON.stringify({ customer: 'old pin' }, null, 2));
  expect(reads()).toBe(1);
});

async function prepareAndLoad(event: ReturnType<typeof userEvent.setup>) {
  await event.click(await screen.findByRole('button', { name: 'Prepare' }));
  await event.click(
    await screen.findByRole('button', { name: 'Use trigger’s pinned sample' }),
  );
}

function mountTriggerInput() {
  const sampleId = '11111111-1111-4111-8111-111111111111';
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
    pendingReads.push(resolve);
  });
  let reads = 0;
  let settled: (() => void) | undefined;
  const sampleSettled = new Promise<void>((resolve) => {
    settled = resolve;
  });
  mockServer.use(
    http.get(`${api}/workflows/${workflowId}/draft/tests/prepare`, () =>
      HttpResponse.json({
        draftRevision: 1,
        samples: [{ nodeId: 'start', sampleId }],
        effectfulSteps: [],
      }),
    ),
    http.get(
      `${api}/workflows/${workflowId}/draft/nodes/start/sample`,
      async () => {
        reads += 1;
        await held;
        return HttpResponse.json({
          sample: {
            id: sampleId,
            nodeId: 'start',
            binding: 'x',
            state: 'pinned',
            source: { kind: 'json' },
            createdAt: '2026-10-01T00:00:00.000Z',
            expiresAt: '2026-12-01T00:00:00.000Z',
          },
          output: { customer: 'old pin' },
          draftRevision: 1,
          limits: { inlineBytes: 262144, depth: 64, members: 10000 },
        });
      },
    ),
    http.get(`${api}/workflows/${workflowId}/draft/test-suites`, () =>
      HttpResponse.json({
        current: {
          signature: 'a'.repeat(64),
          draftRevision: 1,
          variableSetRevision: 0,
          samples: [],
          cases: [],
        },
        items: [],
      }),
    ),
    http.get(`${api}/workflows/${workflowId}/input-cases`, () =>
      HttpResponse.json({ items: [] }),
    ),
    http.get(`${api}/workflows/${workflowId}/draft/tests`, () =>
      HttpResponse.json({ items: [] }),
    ),
  );
  const apiClient = createApiClient({
    fetch: async (...args: Parameters<typeof testFetch>) => {
      try {
        return await testFetch(...args);
      } finally {
        const input = args[0];
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith('/nodes/start/sample')) settled?.();
      }
    },
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  const graph = {
    nodes: [
      {
        id: 'start',
        definition: { key: 'core.manual', version: 1 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    settings: {},
  };
  function Journey() {
    const tests = useWorkflowTests({
      scope: { apiClient, userId, workspaceId, workflowId },
      enabled: true,
      ensureSaved: () => Promise.resolve({ revision: 1 }),
      verifyIdentity: () => Promise.resolve(),
    });
    return (
      <>
        <button
          onClick={() => {
            void tests.prepare();
          }}
        >
          Prepare
        </button>
        <WorkflowTestDialog
          tests={tests}
          workspace={accessibleWorkspaceSchema.parse(
            workspaceWith(['run:start']),
          )}
          workflow={workflowSummarySchema.parse(
            summary(workflowId, 'Test workflow'),
          )}
          graph={graph}
        />
      </>
    );
  }
  renderInRouter(<Journey />);
  const event = userEvent.setup();
  return {
    event,
    release: () => {
      release?.();
    },
    sampleSettled,
    reads: () => reads,
  };
}
