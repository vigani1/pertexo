import { useState } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import {
  accessibleWorkspaceSchema,
  workflowSummarySchema,
} from '@pertexo/contracts';
import { RunInputDialog } from '@/features/workflow-publish/components/run-submission/run-input-dialog';
import { RunMenu } from '@/features/workflow-publish/components/run-submission/run-menu';
import { useWorkflowRunSubmission } from '@/features/workflow-publish/data/mutations/use-workflow-run-submission';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../support/mock-server';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import {
  api,
  discoveryHandlers,
  workspaceWith,
  summary,
  userId,
  workspaceId,
  workflowId,
  versionId,
  problem,
} from '../workflows/list/fixtures';

const casesPath = `${api}/workflows/${workflowId}/input-cases`;
const runPath = `${api}/workflows/${workflowId}/runs`;
const newerVersion = '56565656-5656-4565-8565-565656565656';

function openRunMenu() {
  const apiClient = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  let displayPublication!: (id: string) => void;
  function Harness() {
    const [open, setOpen] = useState(false);
    const [publishedVersionId, setPublishedVersionId] = useState(versionId);
    displayPublication = setPublishedVersionId;
    const submission = useWorkflowRunSubmission({
      apiClient,
      userId,
      workspaceId,
      workflowId,
      verifyIdentity: () => Promise.resolve(),
      ensureSaved: () => Promise.resolve(),
      isSessionPaused: () => false,
      onRunAccepted: vi.fn(),
    });
    return (
      <>
        <RunMenu
          published
          pending={submission.pending}
          acceptedRunPending={submission.acceptedRunId !== undefined}
          unresolvedRun={submission.retryAvailable}
          onRunNow={() => {
            setOpen(true);
          }}
          onRunWithInput={() => {
            setOpen(true);
          }}
          onOpenAcceptedRun={() => void submission.openAcceptedRun()}
        />
        <RunInputDialog
          caseScope={{
            apiClient,
            userId,
            workspace: accessibleWorkspaceSchema.parse(
              workspaceWith(['run:start']),
            ),
            workflow: workflowSummarySchema.parse(
              summary(workflowId, 'Checked start workflow', {
                publishedVersionId,
              }),
            ),
          }}
          command={{
            pending: submission.pending,
            error: submission.error,
            retryAvailable: submission.retryAvailable,
            recoveryIntent: submission.recoveryIntent,
            onStartNew: submission.startNew,
            onRetry: submission.retry,
          }}
          state={{ open, onOpenChange: setOpen }}
        />
      </>
    );
  }
  mockServer.use(...discoveryHandlers(['run:start']));
  return {
    ...renderInRouter(<Harness />),
    displayPublication: (id: string) => {
      displayPublication(id);
    },
    event: userEvent.setup(),
  };
}

async function chooseRun(
  event: ReturnType<typeof userEvent.setup>,
  action = 'Run with input…',
) {
  await event.click(await screen.findByRole('button', { name: 'Run' }));
  await event.click(await screen.findByRole('menuitem', { name: action }));
  return screen.findByRole('button', { name: 'Start published version' });
}

function recordRuns(uncertain = false) {
  const writes: { body: unknown; key: string | null }[] = [];
  mockServer.use(
    http.post(runPath, async ({ request }) => {
      writes.push({
        body: await request.json(),
        key: request.headers.get('idempotency-key'),
      });
      return uncertain
        ? HttpResponse.error()
        : problem(422, 'workflow.invalid');
    }),
  );
  return writes;
}

it.each(['Run published version', 'Run with input…'])(
  'starts from %s with the current publication as its precondition',
  async (action) => {
    mockServer.use(http.get(casesPath, () => HttpResponse.json({ items: [] })));
    const writes = recordRuns();
    const { event } = openRunMenu();
    const start = await chooseRun(event, action);
    expect(start).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Run input (JSON)'), {
      target: { value: '{"proof":"checked"}' },
    });
    await event.click(start);
    await waitFor(() => {
      expect(writes).toHaveLength(1);
    });
    expect(writes[0]?.body).toEqual({
      input: { proof: 'checked' },
      expectedPublishedVersionId: versionId,
    });
    expect(writes[0]?.key).toBeTruthy();
  },
);

it('retries an uncertain checked start byte-for-byte after republication', async () => {
  mockServer.use(http.get(casesPath, () => HttpResponse.json({ items: [] })));
  const writes = recordRuns(true);
  const { event, queryClient, displayPublication } = openRunMenu();
  const start = await chooseRun(event);
  fireEvent.change(screen.getByLabelText('Run input (JSON)'), {
    target: { value: '{"proof":"checked"}' },
  });
  await event.click(start);
  const retry = await screen.findByRole('button', { name: 'Retry same run' });
  act(() => {
    displayPublication(newerVersion);
  });
  await act(() => queryClient.invalidateQueries());
  expect(screen.getByLabelText('Run input (JSON)')).toBeDisabled();
  expect(
    screen.getByText(
      /Retrying uses the version the first attempt was sent to/u,
    ),
  ).toBeVisible();
  expect(retry).toBeEnabled();
  await event.click(retry);
  await waitFor(() => {
    expect(writes).toHaveLength(2);
  });
  expect(writes[0]?.body).toEqual({
    input: { proof: 'checked' },
    expectedPublishedVersionId: versionId,
  });
  expect(writes[1]).toEqual(writes[0]);
});

it('retries an accepted-then-503 start with the original key instead of creating a second run', async () => {
  const accepted = new Map<string, string>();
  const writes: { key: string; body: unknown }[] = [];
  mockServer.use(
    http.get(casesPath, () => HttpResponse.json({ items: [] })),
    http.post(runPath, async ({ request }) => {
      const key = request.headers.get('idempotency-key');
      if (key === null) return problem(400, 'request.invalid');
      writes.push({ key, body: await request.json() });
      const previous = accepted.get(key);
      const id = previous ?? crypto.randomUUID();
      accepted.set(key, id);
      if (writes.length === 1)
        return problem(503, 'request.rate_limit_unavailable');
      return HttpResponse.json(
        {
          run: {
            id,
            workspaceId,
            workflowId,
            workflowVersionId: versionId,
            status: 'queued',
            triggerType: 'manual',
            createdAt: '2026-09-14T10:00:00.000Z',
            updatedAt: '2026-09-14T10:00:00.000Z',
            startedAt: null,
            completedAt: null,
            deadlineAt: null,
            cancelRequestedAt: null,
          },
          replayed: previous !== undefined,
        },
        { status: 202 },
      );
    }),
  );
  const { event } = openRunMenu();
  const start = await chooseRun(event);
  fireEvent.change(screen.getByLabelText('Run input (JSON)'), {
    target: { value: '{"proof":"accepted"}' },
  });
  await event.click(start);
  const retry = await screen.findByRole('button', { name: 'Retry same run' });
  expect(screen.getByLabelText('Run input (JSON)')).toBeDisabled();
  await event.click(retry);
  await waitFor(() => {
    expect(writes).toHaveLength(2);
  });
  expect(writes[1]).toEqual(writes[0]);
  expect(accepted.size).toBe(1);
});
