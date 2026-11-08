import { useState } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import {
  publicationReviewSchema,
  userProfileResponseSchema,
  accessibleWorkspaceSchema,
} from '@pertexo/contracts';
import { PublicationReviewPage } from '@/features/workflow-publish/reviews.public';
import { WorkflowVersionsPage } from '@/features/workflow-settings/pages/workflow-versions';
import { workflowSettingsKeys } from '@/features/workflow-settings/workflow-settings-queries.public';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import { mockServer } from '../../support/mock-server';
import {
  version,
  versionId,
  olderVersionId,
  workflowId,
  workflowApi,
  api,
  userId,
  workspaceId,
  summary,
} from '../workflow-settings/fixtures';
import { user, workspaceWith } from '../workflows/list/fixtures';

it('loads the newly approved publication when opening a recently cached Versions list', async () => {
  const reviewId = '99999999-9999-4999-8999-999999999999';
  const request = publicationReviewSchema.parse({
    id: reviewId,
    workflowId,
    workflowName: 'Release',
    requestedBy: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    requesterName: 'Builder',
    draftRevision: 1,
    note: '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    decidedBy: null,
    deciderName: null,
    decidedAt: null,
    comment: null,
    publishedVersionId: null,
    versionNumber: null,
    canDecide: true,
  });
  const apiClient = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  let published = false;
  let reads = 0;
  mockServer.use(
    http.get(`${api}/publication-requests/${reviewId}`, () =>
      HttpResponse.json({
        request: published
          ? {
              ...request,
              status: 'approved',
              decidedBy: userId,
              deciderName: 'Reviewer',
              decidedAt: new Date().toISOString(),
              publishedVersionId: versionId,
              versionNumber: 2,
              canDecide: false,
            }
          : request,
        graph: null,
        liveGraph: null,
      }),
    ),
    http.post(`${api}/publication-requests/${reviewId}/decision`, () => {
      published = true;
      return HttpResponse.json({
        ...request,
        status: 'approved',
        decidedBy: userId,
        deciderName: 'Reviewer',
        decidedAt: new Date().toISOString(),
        publishedVersionId: versionId,
        versionNumber: 2,
        canDecide: false,
      });
    }),
    http.get(`${workflowApi}/versions`, () => {
      reads += 1;
      return HttpResponse.json({
        items: published
          ? [version(versionId, 2), version(olderVersionId, 1)]
          : [version(olderVersionId, 1)],
        nextCursor: null,
      });
    }),
    http.get(workflowApi, () =>
      HttpResponse.json({
        workflow: { ...summary, publishedVersionId: versionId },
      }),
    ),
  );
  function Journey() {
    const [showVersions, setShowVersions] = useState(false);
    return showVersions ? (
      <WorkflowVersionsPage
        apiClient={apiClient}
        user={userProfileResponseSchema.parse(user)}
        workspace={accessibleWorkspaceSchema.parse(workspaceWith([]))}
        workflowId={workflowId}
      />
    ) : (
      <>
        <PublicationReviewPage
          scope={{ apiClient, userId, workspaceId }}
          reviewId={reviewId}
          capabilities={[]}
        />
        <button
          onClick={() => {
            setShowVersions(true);
          }}
        >
          Open Versions
        </button>
      </>
    );
  }
  const { queryClient } = renderInRouter(<Journey />);
  queryClient.setQueryData(
    workflowSettingsKeys.versions(userId, workspaceId, workflowId),
    { items: [version(olderVersionId, 1)], nextCursor: null },
  );
  const event = userEvent.setup();
  await event.click(
    await screen.findByRole('button', { name: 'Approve and publish' }),
  );
  await screen.findByText('Published v2. This decision is complete.');
  await event.click(screen.getByRole('button', { name: 'Open Versions' }));
  expect(
    await screen.findByRole('button', { name: 'Preview v2' }),
  ).toBeVisible();
  expect(reads).toBeGreaterThan(0);
});
