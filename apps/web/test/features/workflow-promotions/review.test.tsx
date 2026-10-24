import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { WorkflowPromotionPreview } from '@pertexo/contracts';
import { WorkflowPromotionPage } from '@/features/workflow-promotions/public';
import { promotionSettingsQuery } from '@/features/workflow-promotions/data/promotions.queries';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import {
  workspaceWith,
  userId,
  workspaceId,
  workflowId,
  versionId,
} from '../workflows/list/fixtures';
const targetId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const targetWorkflowId = '99999999-9999-4999-8999-999999999999';
const graph = { nodes: [], edges: [], settings: {} };
const preview: WorkflowPromotionPreview = {
  fingerprint: 'a'.repeat(64),
  sourceWorkspaceId: workspaceId,
  sourceWorkspaceName: 'Development',
  targetWorkspaceId: targetId,
  targetWorkspaceName: 'Production',
  mode: 'draft',
  requireApproval: false,
  compatible: true,
  workflows: [
    {
      sourceWorkflowId: workflowId,
      sourceName: 'Release',
      sourceVersionId: versionId,
      sourceVersionNumber: 1,
      sourceChecksum: `wf:sha256:${'a'.repeat(64)}`,
      targetWorkflowId,
      targetName: 'Release',
      targetRevision: 2,
      targetPublishedVersionId: null,
      directChanges: true,
      proposedGraph: graph,
      targetGraph: graph,
    },
  ],
  requirements: [],
};
function json(value: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}
it('keeps the exact reviewed command through a lost response and preserves target edits until acknowledged', async () => {
  const requests: { body: string; key: string }[] = [];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation((input, init) => {
      const path =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (path.includes('/promotions/settings'))
        return json({
          revision: 1,
          canConfigure: true,
          target: {
            status: 'available',
            workspaceId: targetId,
            name: 'Production',
            requireApproval: false,
          },
        });
      if (path.includes('/promotions/candidates'))
        return json({ items: [], nextCursor: null, nextVersionNumber: null });
      if (path.includes('/promotions/history'))
        return json({ items: [], nextCursor: null });
      if (path.endsWith('/promotions/preview')) return json(preview);
      if (path.endsWith('/promotions/apply')) {
        if (typeof init?.body !== 'string')
          throw new Error('Expected a JSON command');
        requests.push({
          body: init.body,
          key: new Headers(init.headers).get('Idempotency-Key') ?? '',
        });
        if (requests.length === 1)
          return Promise.reject(new TypeError('Synthetic lost response'));
        return json({
          promotionId: '88888888-8888-4888-8888-888888888888',
          sourceWorkspaceId: workspaceId,
          targetWorkspaceId: targetId,
          replayed: true,
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
      }
      if (path.includes('/v1/workspaces'))
        return json({ items: [], nextCursor: null });
      throw new Error(`Unexpected request ${path}`);
    });
  const apiClient = createApiClient({
    fetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  const scope = { apiClient, userId, workspaceId };
  const select = vi.fn();
  const rendered = renderInRouter(
    <WorkflowPromotionPage
      scope={scope}
      workspace={workspaceWith(['workflow:update', 'workflow:publish'])}
      selected={`${workflowId}:${versionId}`}
      onSelect={select}
    />,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'Review promotion' }),
  );
  const apply = await screen.findByRole('button', {
    name: 'Create target drafts',
  });
  expect(apply).toBeDisabled();
  await user.click(
    screen.getByRole('checkbox', { name: 'Replace these target changes' }),
  );
  await rendered.queryClient.invalidateQueries({
    queryKey: promotionSettingsQuery(scope).queryKey,
  });
  expect(
    screen.getByRole('checkbox', { name: 'Replace these target changes' }),
  ).toBeChecked();
  await user.click(apply);
  expect(
    await screen.findByRole('button', { name: 'Retry same promotion' }),
  ).toBeEnabled();
  expect(
    screen.getByRole('button', { name: 'Review promotion' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Clear selection' }),
  ).toBeDisabled();
  await user.click(
    screen.getByRole('button', { name: 'Retry same promotion' }),
  );
  expect(
    await screen.findByRole('link', { name: 'Open target draft r3' }),
  ).toHaveAttribute('href', `/w/${targetId}/workflows/${targetWorkflowId}`);
  await waitFor(() => {
    expect(requests).toHaveLength(2);
  });
  expect(requests[1]).toEqual(requests[0]);
  expect(JSON.parse(requests[0]?.body ?? '{}') as unknown).toMatchObject({
    fingerprint: preview.fingerprint,
    acknowledgeTargetChanges: [workflowId],
    selections: [{ workflowId, versionId }],
  });
  expect(select).not.toHaveBeenCalled();
});

it('clears the protected review when apply loses workspace access', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
    const path =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (path.includes('/promotions/settings'))
      return json({
        revision: 1,
        canConfigure: true,
        target: {
          status: 'available',
          workspaceId: targetId,
          name: 'Production',
          requireApproval: false,
        },
      });
    if (path.includes('/promotions/candidates'))
      return json({ items: [], nextCursor: null, nextVersionNumber: null });
    if (
      path.includes('/promotions/history') ||
      (path.includes('/v1/workspaces') && !path.includes('/promotions/'))
    )
      return json({ items: [], nextCursor: null });
    if (path.endsWith('/promotions/preview')) return json(preview);
    if (path.endsWith('/promotions/apply'))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'https://pertexo.com/problems/forbidden',
            title: 'Forbidden',
            status: 403,
            code: 'forbidden',
          }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/problem+json' },
          },
        ),
      );
    throw new Error(`Unexpected request ${path}`);
  });
  const apiClient = createApiClient({
    fetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  renderInRouter(
    <WorkflowPromotionPage
      scope={{ apiClient, userId, workspaceId }}
      workspace={workspaceWith(['workflow:update', 'workflow:publish'])}
      selected={`${workflowId}:${versionId}`}
      onSelect={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'Review promotion' }),
  );
  await user.click(
    await screen.findByRole('checkbox', {
      name: 'Replace these target changes',
    }),
  );
  await user.click(
    screen.getByRole('button', { name: 'Create target drafts' }),
  );
  await waitFor(() => {
    expect(
      screen.queryByRole('checkbox', { name: 'Replace these target changes' }),
    ).not.toBeInTheDocument();
  });
  expect(
    screen.queryByRole('button', { name: 'Create target drafts' }),
  ).not.toBeInTheDocument();
});

it('tells a viewer promotion needs edit access without asking for its settings', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const scope = {
    apiClient: createApiClient({
      fetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    }),
    userId,
    workspaceId,
  };
  renderInRouter(
    <WorkflowPromotionPage
      scope={scope}
      workspace={workspaceWith([])}
      onSelect={vi.fn()}
    />,
  );
  expect(
    await screen.findByRole('heading', { name: 'Promotion' }),
  ).toBeVisible();
  expect(
    screen.getByText('Promotion needs edit access in an active workspace.'),
  ).toBeVisible();
  expect(fetch).not.toHaveBeenCalled();
});
