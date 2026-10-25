import { workflowKeys } from '@/features/workflows/queries.public';

import { ApiError } from '@/lib/api/error';

import { screen } from '@testing-library/react';

import { http, HttpResponse } from 'msw';

import { afterEach, describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { mountList, prepare, retireHistories } from './fixture';

import { api, userId, workflowId, workspaceId } from '../list/fixtures';

afterEach(() => {
  for (const retire of retireHistories.splice(0)) retire();
});

describe('Workflow list owns import recovery across dialog dismissal', () => {
  it('releases blocked same-scope departure on authority loss while retaining no recoverable payload', async () => {
    mockServer.use(
      http.post(`${api}/workflows/import`, () => HttpResponse.error()),
    );
    const { event, router, queryClient } = mountList(true);
    await prepare(event);
    await screen.findByRole('button', { name: 'Retry exact import' });
    await event.click(screen.getByRole('button', { name: 'Close' }));
    void router.navigate({ to: '/w/$workspaceId', params: { workspaceId } });
    await screen.findByRole('heading', {
      name: 'Resolve the import before leaving',
    });
    await queryClient
      .query({
        queryKey: workflowKeys.detail(userId, workspaceId, workflowId),
        queryFn: () =>
          Promise.reject(
            new ApiError({ kind: 'problem', message: 'Denied', status: 403 }),
          ),
        retry: false,
      })
      .catch(() => undefined);
    await screen.findByRole('heading', { name: 'Destination page' });
    expect(
      screen.queryByRole('button', { name: 'Retry exact import' }),
    ).not.toBeInTheDocument();
  });
});
