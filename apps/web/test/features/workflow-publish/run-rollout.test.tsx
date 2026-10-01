import { useState } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import { accessibleWorkspaceSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { workflowSummarySchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { RunInputDialog } from '@/features/workflow-publish/components/run-submission/run-input-dialog';
import { RunMenu } from '@/features/workflow-publish/components/run-submission/run-menu';
import { useWorkflowRunSubmission } from '@/features/workflow-publish/mutations/use-workflow-run-submission';
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
} from '../workflows/workflow-list.fixtures';

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
          open={open}
          onOpenChange={setOpen}
          pending={submission.pending}
          error={submission.error}
          retryAvailable={submission.retryAvailable}
          recoveryIntent={submission.recoveryIntent}
          onStartNew={submission.startNew}
          onRetry={submission.retry}
          caseScope={{
            apiClient,
            userId,
            workspace: accessibleWorkspaceSchema.parse(
              workspaceWith(['run:start']),
            ),
            workflow: workflowSummarySchema.parse(
              summary(workflowId, 'Rollout workflow', { publishedVersionId }),
            ),
          }}
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
  'keeps %s explicitly confirmable and unchecked with rollout disabled',
  async (action) => {
    mockServer.use(
      http.get(casesPath, () =>
        problem(503, 'workflow.input_cases_unavailable'),
      ),
    );
    const writes = recordRuns();
    const { event } = openRunMenu();
    const start = await chooseRun(event, action);
    await screen.findByText(/An ordinary run uses the publication current/u);
    expect(
      screen.queryByRole('button', { name: 'New input case' }),
    ).not.toBeInTheDocument();
    expect(writes).toEqual([]);
    expect(start).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Run input (JSON)'), {
      target: { value: '{"proof":"ordinary"}' },
    });
    await event.click(start);
    await waitFor(() => {
      expect(writes).toHaveLength(1);
    });
    expect(writes[0]?.body).toEqual({ input: { proof: 'ordinary' } });
    expect(writes[0]?.key).toBeTruthy();
  },
);

it('does not infer unchecked availability from pending or failed discovery', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockServer.use(
    http.get(casesPath, async () => {
      await held;
      return problem(500, 'internal.unexpected');
    }),
  );
  const writes = recordRuns();
  const { event } = openRunMenu();
  const start = await chooseRun(event);
  expect(start).toBeDisabled();
  release();
  await screen.findByRole('button', { name: 'Retry' });
  expect(start).toBeDisabled();
  expect(writes).toEqual([]);
});

it('keeps an uncertain checked command byte-for-byte on rollback and republication', async () => {
  let enabled = true;
  mockServer.use(
    http.get(casesPath, () =>
      enabled
        ? HttpResponse.json({ items: [] })
        : problem(503, 'workflow.input_cases_unavailable'),
    ),
  );
  const writes = recordRuns(true);
  const { event, queryClient, displayPublication } = openRunMenu();
  const start = await chooseRun(event);
  await waitFor(() => {
    expect(start).toBeEnabled();
  });
  fireEvent.change(screen.getByLabelText('Run input (JSON)'), {
    target: { value: '{"proof":"checked"}' },
  });
  await event.click(start);
  const retry = await screen.findByRole('button', { name: 'Retry same run' });
  enabled = false;
  act(() => {
    displayPublication(newerVersion);
  });
  await act(() => queryClient.invalidateQueries());
  await screen.findByText(/Input cases aren’t enabled/u);
  expect(screen.getByLabelText('Run input (JSON)')).toBeDisabled();
  expect(screen.getByText(/Original submitted version/u)).toHaveTextContent(
    versionId,
  );
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

it('does not downgrade a previously submitted checked command after a definitive rejection', async () => {
  let enabled = true;
  mockServer.use(
    http.get(casesPath, () =>
      enabled
        ? HttpResponse.json({ items: [] })
        : problem(503, 'workflow.input_cases_unavailable'),
    ),
  );
  const writes = recordRuns();
  const { event, queryClient } = openRunMenu();
  const start = await chooseRun(event);
  await waitFor(() => {
    expect(start).toBeEnabled();
  });
  await event.click(start);
  await waitFor(() => {
    expect(writes).toHaveLength(1);
    expect(start).toBeEnabled();
  });
  enabled = false;
  await act(() => queryClient.invalidateQueries());
  await screen.findByText(/Input cases aren’t enabled/u);
  await waitFor(() => {
    expect(start).toBeDisabled();
  });
  expect(writes[0]?.body).toEqual({
    input: {},
    expectedPublishedVersionId: versionId,
  });
  expect(writes).toHaveLength(1);
});

it('keeps an uncertain unchecked retry unchecked when rollout becomes available', async () => {
  let enabled = false;
  mockServer.use(
    http.get(casesPath, () =>
      enabled
        ? HttpResponse.json({ items: [] })
        : problem(503, 'workflow.input_cases_unavailable'),
    ),
  );
  const writes = recordRuns(true);
  const { event, queryClient } = openRunMenu();
  const start = await chooseRun(event);
  await waitFor(() => {
    expect(start).toBeEnabled();
  });
  await event.click(start);
  const retry = await screen.findByRole('button', { name: 'Retry same run' });
  enabled = true;
  await act(() => queryClient.invalidateQueries());
  await screen.findByText(/No input cases yet/u);
  expect(
    screen.queryByText(/Current published version/u),
  ).not.toBeInTheDocument();
  await event.click(retry);
  await waitFor(() => {
    expect(writes).toHaveLength(2);
  });
  expect(writes[0]?.body).toEqual({ input: {} });
  expect(writes[1]).toEqual(writes[0]);
});

it('does not downgrade a loaded case when the rollout gate is withdrawn', async () => {
  const caseId = '34343434-3434-4343-8343-343434343434';
  const metadata = {
    id: caseId,
    workspaceId,
    workflowId,
    workflowVersionId: versionId,
    versionChecksum: `wf:v1:sha256:${'a'.repeat(64)}`,
    name: 'Bound input',
    revision: 1,
    representationTag: `"wic1.${caseId.replaceAll('-', '')}.1"`,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
  };
  let enabled = true;
  mockServer.use(
    http.get(casesPath, () =>
      enabled
        ? HttpResponse.json({ items: [metadata] })
        : problem(503, 'workflow.input_cases_unavailable'),
    ),
    http.get(`${casesPath}/${caseId}`, () =>
      HttpResponse.json(
        { case: { ...metadata, input: { proof: 'bound' } } },
        { headers: { ETag: metadata.representationTag } },
      ),
    ),
  );
  const writes = recordRuns();
  const { event, queryClient } = openRunMenu();
  const start = await chooseRun(event);
  await event.click(
    await screen.findByRole('button', { name: 'Load Bound input' }),
  );
  await screen.findByText(/Loaded case: Bound input/u);
  enabled = false;
  await act(() => queryClient.invalidateQueries());
  await screen.findByText(/Input cases aren’t enabled/u);
  expect(start).toBeDisabled();
  expect(screen.getByLabelText('Run input (JSON)')).toHaveValue(
    JSON.stringify({ proof: 'bound' }, null, 2),
  );
  expect(writes).toEqual([]);
});
