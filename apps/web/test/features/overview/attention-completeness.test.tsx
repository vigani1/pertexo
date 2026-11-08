import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { AttentionSection } from '@/features/overview/components/attention-section';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import { fixtureWorkspace } from '../../support/fixtures/run';
import { mockServer } from '../../support/mock-server';
import { workflow } from './page/fixture';

it('discloses partial workflow evidence instead of announcing a workspace-wide all-clear', async () => {
  const reads: string[] = [];
  mockServer.use(
    http.get('*/v1/workspaces/:workspaceId/workflows', ({ request }) => {
      reads.push(request.url);
      return HttpResponse.json(
        new URL(request.url).searchParams.has('after')
          ? {
              items: [workflow({ activationStatus: 'error' })],
              nextCursor: null,
            }
          : {
              items: Array.from({ length: 25 }, (_, index) =>
                workflow({
                  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                }),
              ),
              nextCursor: 'next-page',
            },
      );
    }),
  );
  const workspace = fixtureWorkspace(['workspace:read', 'workflow:read']);
  renderInRouter(
    <AttentionSection
      apiClient={createApiClient({
        fetch: testFetch,
        readCsrfToken: () => undefined,
      })}
      userId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      workspace={workspace}
    />,
  );
  expect(
    await screen.findByText(
      'Only loaded workflows were checked. Older workflows may need attention.',
    ),
  ).toBeVisible();
  expect(screen.queryByText('All clear.')).not.toBeInTheDocument();
  expect(
    screen.getByRole('link', { name: 'Review all workflows' }),
  ).toHaveAttribute('href', `/w/${workspace.id}/workflows`);
  expect(reads).toHaveLength(1);
});
