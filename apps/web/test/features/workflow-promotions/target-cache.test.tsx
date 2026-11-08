import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { usePromotionApply } from '@/features/workflow-promotions/data/promotions.mutations';
import { workflowSummaryQueryOptions } from '@/features/workflows/workflows-queries.public';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import { mockServer } from '../../support/mock-server';
import {
  api,
  summary,
  userId,
  workspaceId,
  workflowId,
  versionId,
} from '../workflows/list/fixtures';
import { targetId, targetWorkflowId } from './review.fixture';

it('refreshes a previously read target after promotion creates its new draft', async () => {
  const apiClient = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  let applied = false;
  let reads = 0;
  mockServer.use(
    http.get(
      `http://pertexo.test/v1/workspaces/${targetId}/workflows/${targetWorkflowId}`,
      () => {
        reads += 1;
        return HttpResponse.json({
          workflow: {
            ...summary(targetWorkflowId, 'Previous target'),
            id: targetWorkflowId,
            workspaceId: targetId,
            name: applied ? 'Promoted target' : 'Previous target',
          },
        });
      },
    ),
    http.post(`${api}/promotions/apply`, () => {
      applied = true;
      return HttpResponse.json({
        promotionId: '88888888-8888-4888-8888-888888888888',
        sourceWorkspaceId: workspaceId,
        targetWorkspaceId: targetId,
        replayed: false,
        items: [
          {
            sourceWorkflowId: workflowId,
            targetWorkflowId,
            revision: 3,
            publishedVersionId: null,
            versionNumber: null,
            publicationRequestId: null,
          },
        ],
      });
    }),
  );
  function Journey() {
    const [target, setTarget] = useState(true);
    const command = usePromotionApply(
      { apiClient, userId, workspaceId },
      () => undefined,
    );
    const current = useQuery({
      ...workflowSummaryQueryOptions(
        apiClient,
        userId,
        targetId,
        targetWorkflowId,
      ),
      enabled: target,
    });
    return target ? (
      <>
        <p>{current.data?.name}</p>
        <button
          onClick={() => {
            setTarget(false);
          }}
        >
          Review promotion
        </button>
      </>
    ) : (
      <>
        <button
          onClick={() => {
            void command.send({
              selections: [{ workflowId, versionId }],
              mode: 'draft',
              fingerprint: 'a'.repeat(64),
              acknowledgeTargetChanges: [workflowId],
            });
          }}
        >
          Apply promotion
        </button>
        {command.data === undefined ? null : <p>Promotion complete</p>}
        <button
          onClick={() => {
            setTarget(true);
          }}
        >
          Open target
        </button>
      </>
    );
  }
  renderInRouter(<Journey />);
  const event = userEvent.setup();
  await screen.findByText('Previous target');
  await event.click(screen.getByRole('button', { name: 'Review promotion' }));
  await event.click(screen.getByRole('button', { name: 'Apply promotion' }));
  await screen.findByText('Promotion complete');
  await event.click(screen.getByRole('button', { name: 'Open target' }));
  expect(await screen.findByText('Promoted target')).toBeVisible();
  expect(reads).toBeGreaterThan(1);
});
