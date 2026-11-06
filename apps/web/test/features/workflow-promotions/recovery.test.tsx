import { getRequestUrl } from '../../support/request';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { WorkflowPromotionPage } from '@/features/workflow-promotions/public';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import {
  workspaceWith,
  userId,
  workspaceId,
  workflowId,
  versionId,
} from '../workflows/list/fixtures';
import { targetId, preview, json } from './review.fixture';
it.each([
  [
    'stale',
    'The source, target or its setup changed. Review this promotion again.',
  ],
  [
    'target',
    'A target workflow was edited directly. Review and explicitly acknowledge replacing its changes.',
  ],
  [
    'requirements',
    'Resolve the missing or incompatible requirements before promoting.',
  ],
] as const)(
  'recovers a %s promotion refusal with a fresh review while keeping selection and note',
  async (kind, detail) => {
    const reviews: unknown[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation((input, init) => {
        const path = getRequestUrl(input);
        if (path.includes('/promotions/settings'))
          return json({
            revision: 1,
            canConfigure: true,
            target: {
              status: 'available',
              workspaceId: targetId,
              name: 'Production',
              requireApproval: true,
            },
          });
        if (path.includes('/promotions/candidates'))
          return json({ items: [], nextCursor: null, nextVersionNumber: null });
        if (path.includes('/promotions/history'))
          return json({ items: [], nextCursor: null });
        if (path.endsWith('/promotions/preview')) {
          if (typeof init?.body !== 'string')
            throw new Error('Expected a JSON review request');
          reviews.push(JSON.parse(init.body) as unknown);
          const renewed = reviews.length > 1;
          return json({
            ...preview,
            mode: 'request_approval',
            requireApproval: true,
            fingerprint: (renewed ? 'b' : 'a').repeat(64),
            compatible: !(renewed && kind === 'requirements'),
            workflows: preview.workflows.map((workflow) => ({
              ...workflow,
              directChanges: renewed && kind === 'target',
            })),
            requirements:
              renewed && kind === 'requirements'
                ? [
                    {
                      kind: 'variable',
                      workflowId,
                      name: 'TOKEN',
                      status: 'missing',
                      detail:
                        'Set TOKEN in the target workspace before reviewing again.',
                    },
                  ]
                : [],
          });
        }
        if (path.endsWith('/promotions/apply'))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                type: 'urn:pertexo:problem:workflow.promotion_conflict',
                title: 'Promotion changed',
                status: 409,
                code: 'workflow.promotion_conflict',
                detail,
                requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              }),
              {
                status: 409,
                headers: { 'Content-Type': 'application/problem+json' },
              },
            ),
          );
        return json({});
      });
    const apiClient = createApiClient({
      fetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
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
      await screen.findByRole('combobox', { name: /Target action/u }),
    );
    await user.click(
      await screen.findByRole('option', { name: 'Request approval' }),
    );
    await user.type(
      await screen.findByRole('textbox', { name: /Review note/u }),
      'Keep this release note',
    );
    await user.click(screen.getByRole('button', { name: 'Review promotion' }));
    await user.click(
      await screen.findByRole('button', { name: 'Request target approval' }),
    );
    expect(await screen.findByText(detail)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Request target approval' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review again' }));
    await waitFor(() => {
      expect(reviews).toHaveLength(2);
    });
    expect(reviews[1]).toEqual(reviews[0]);
    expect(
      await screen.findByRole('textbox', { name: /Review note/u }),
    ).toHaveValue('Keep this release note');
    if (kind === 'target') {
      expect(
        await screen.findByRole('checkbox', {
          name: 'Replace these target changes',
        }),
      ).not.toBeChecked();
      expect(
        screen.getByRole('button', { name: 'Request target approval' }),
      ).toBeDisabled();
    }
    if (kind === 'requirements')
      expect(
        await screen.findByText(
          'Set TOKEN in the target workspace before reviewing again.',
        ),
      ).toBeVisible();
  },
);
