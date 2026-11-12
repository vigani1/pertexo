import { act, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { workflowShapeQueryOptions } from '@/features/workflows/data/workflows.queries';
import { createApiClient } from '@/lib/api/client';
import { testFetch } from '../../support/render-app';
import { mockServer } from '../../support/mock-server';
import { mountList, prepare } from './import-recovery/fixture';
import { api, userId, workspaceId, workflowId } from './list/fixtures';

it('keeps a pending import and its exact retry when an unrelated workflow preview is unavailable', async () => {
  const attempts: { body: unknown; key: string | null }[] = [];
  mockServer.use(
    http.post(`${api}/workflows/import`, async ({ request }) => {
      attempts.push({
        body: await request.json(),
        key: request.headers.get('idempotency-key'),
      });
      return HttpResponse.error();
    }),
    http.get(`${api}/workflows/${workflowId}/draft`, () =>
      HttpResponse.json(
        {
          type: 'urn:pertexo:problem:resource.not_found',
          title: 'Not found',
          status: 404,
          code: 'resource.not_found',
          requestId: 'optional-row-preview',
        },
        { status: 404 },
      ),
    ),
  );
  const { event, queryClient } = mountList();
  await prepare(event);
  await screen.findByRole('button', { name: 'Retry exact import' });
  const options = workflowShapeQueryOptions(
    createApiClient({ fetch: testFetch, readCsrfToken: () => undefined }),
    userId,
    workspaceId,
    workflowId,
  );
  await act(async () => {
    await expect(
      queryClient.query({ ...options, retry: false }),
    ).rejects.toMatchObject({ status: 404 });
  });
  expect(screen.getByLabelText('New workflow name')).toHaveValue(
    'Frozen recovery draft',
  );
  await event.click(screen.getByRole('button', { name: 'Retry exact import' }));
  await screen.findByRole('button', { name: 'Retry exact import' });
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
});
