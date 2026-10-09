import { useState } from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import {
  accessibleWorkspaceSchema,
  workflowSummarySchema,
} from '@pertexo/contracts';
import { RunInputDialog } from '@/features/workflow-publish/components/run-submission/run-input-dialog';
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
} from '../workflows/list/fixtures';

it('blocks new case and run commands until a reviewed publication is actually displayed', async () => {
  const reviewedId = '56565656-5656-4565-8565-565656565656';
  const caseId = '34343434-3434-4343-8343-343434343434';
  const originalId = '45454545-4545-4545-8545-454545454545';
  const path = `${api}/workflows/${workflowId}/input-cases`;
  const writes: unknown[] = [];
  const original = {
    id: originalId,
    workspaceId,
    workflowId,
    workflowVersionId: versionId,
    versionChecksum: `wf:v2:sha256:${'a'.repeat(64)}`,
    name: 'Original case',
    revision: 1,
    representationTag: `"wic1.${originalId.replaceAll('-', '')}.1"`,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
  };
  const records = [original];
  mockServer.use(
    ...discoveryHandlers(['workflow:update', 'run:start']),
    http.get(path, () => HttpResponse.json({ items: records })),
    http.get(`${path}/:caseId`, ({ params }) => {
      const record = records.find((item) => item.id === params.caseId);
      return HttpResponse.json(
        { case: { ...record, input: {} } },
        {
          headers: { ETag: record?.representationTag ?? '' },
        },
      );
    }),
    http.post(path, async ({ request }) => {
      writes.push(await request.json());
      records.push({
        ...original,
        id: caseId,
        name: 'Reviewed case',
        workflowVersionId: reviewedId,
        representationTag: `"wic1.${caseId.replaceAll('-', '')}.1"`,
      });
      return HttpResponse.json(
        { caseId, revision: 1, replayed: false },
        { status: 201 },
      );
    }),
  );
  const apiClient = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  let resolveReview!: (id: string) => void;
  const heldReview = new Promise<string>((resolve) => {
    resolveReview = resolve;
  });
  let displayPublication!: (id: string) => void;
  const start = vi.fn().mockResolvedValue(false);
  const retry = vi.fn().mockResolvedValue(true);
  function Harness() {
    const [displayedId, setDisplayedId] = useState(versionId);
    const [conflict, setConflict] = useState(true);
    const [recovering, setRecovering] = useState(false);
    displayPublication = setDisplayedId;
    return (
      <RunInputDialog
        open
        pending={false}
        error="No run started."
        retryAvailable={recovering}
        recoveryIntent={
          recovering
            ? { value: {}, expectedPublishedVersionId: reviewedId }
            : undefined
        }
        publicationConflict={conflict}
        onOpenChange={vi.fn()}
        onStartNew={async (intent) => {
          await start(intent);
          setRecovering(true);
          return false;
        }}
        onRetry={retry}
        onReviewPublication={async () => {
          const id = await heldReview;
          setConflict(false);
          return id;
        }}
        caseScope={{
          apiClient,
          userId,
          workspace: accessibleWorkspaceSchema.parse(
            workspaceWith(['workflow:update', 'run:start']),
          ),
          workflow: workflowSummarySchema.parse(
            summary(workflowId, 'Reviewed workflow', {
              publishedVersionId: displayedId,
            }),
          ),
        }}
      />
    );
  }
  renderInRouter(<Harness />);
  const event = userEvent.setup();
  const newCase = await screen.findByRole('button', { name: 'New input case' });
  await event.click(screen.getByRole('button', { name: 'Load Original case' }));
  await screen.findByText(/Loaded case: Original case/u);
  await event.click(
    screen.getByRole('button', {
      name: 'Read current publication and review copied input',
    }),
  );
  expect(newCase).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Start published version' }),
  ).toBeDisabled();
  act(() => {
    resolveReview(reviewedId);
  });
  await screen.findByText(/Waiting for the reviewed publication/u);
  expect(newCase).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Start published version' }),
  ).toBeDisabled();
  await event.click(newCase);
  expect(screen.queryByLabelText('Case name')).not.toBeInTheDocument();
  expect(writes).toEqual([]);
  expect(start).not.toHaveBeenCalled();
  act(() => {
    displayPublication(reviewedId);
  });
  await waitFor(() => {
    expect(newCase).toBeEnabled();
  });
  expect(
    screen.getByRole('button', { name: 'Start published version' }),
  ).toBeDisabled();
  expect(
    screen.queryByRole('button', {
      name: 'Review current publication for this copied input',
    }),
  ).not.toBeInTheDocument();
  expect(start).not.toHaveBeenCalled();
  await event.click(newCase);
  await event.type(screen.getByLabelText('Case name'), 'Reviewed case{Enter}');
  expect(start).not.toHaveBeenCalled();
  expect(
    screen.getByRole('button', { name: 'Start published version' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Start published version' }),
  ).toBeDisabled();
  expect(screen.getByLabelText('Case name')).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Save input case' })).toBeEnabled();
  await event.click(screen.getByRole('button', { name: 'Save input case' }));
  await waitFor(() => {
    expect(writes).toHaveLength(1);
  });
  expect(writes[0]).toEqual({
    workflowVersionId: reviewedId,
    name: 'Reviewed case',
    input: {},
  });
  expect(start).not.toHaveBeenCalled();
  await screen.findByRole('button', { name: 'New input case' });
  expect(
    screen.getByRole('button', { name: 'Start published version' }),
  ).toBeDisabled();
  await event.click(
    await screen.findByRole('button', { name: 'Load Reviewed case' }),
  );
  await waitFor(() => {
    expect(
      screen.getByRole('button', { name: 'Start published version' }),
    ).toBeEnabled();
  });
  await event.click(
    screen.getByRole('button', { name: 'Start published version' }),
  );
  const retryButton = await screen.findByRole('button', {
    name: 'Retry same run',
  });
  act(() => {
    displayPublication(versionId);
  });
  await waitFor(() => {
    expect(retryButton).toBeEnabled();
  });
  await event.click(retryButton);
  expect(retry).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledWith({
    value: {},
    expectedPublishedVersionId: reviewedId,
  });
});
