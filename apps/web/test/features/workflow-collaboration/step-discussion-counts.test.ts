import { QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { stepDiscussionsQuery } from '@/features/workflow-collaboration/data/collaboration.queries';
import { createApiClient } from '@/lib/api/client';
import { getRequestUrl } from '../../support/request';
import {
  userId,
  workflowId,
  workspaceId,
} from '../../support/fixtures/workflow-editor';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Step badges count the hundred most recent open discussions, read a page
// of 20 at a time.
it('counts open discussions per step across the hundred most recent', async () => {
  const limits: string[] = [];
  let served = 0;
  const fetch = vi.fn<typeof globalThis.fetch>((input) => {
    const url = new URL(getRequestUrl(input), 'http://pertexo.test');
    const limit = Number(url.searchParams.get('limit'));
    limits.push(String(limit));
    const items = Array.from({ length: limit }, () => {
      served += 1;
      return {
        id: uuid(served),
        workflowId,
        stepId: served % 2 === 0 ? 'check' : 'notify',
        stepLabel: null,
        status: 'open',
        revision: 1,
        createdBy: userId,
        createdAt: '2026-10-18T10:00:00.000Z',
        updatedAt: '2026-10-18T10:00:00.000Z',
        commentCount: 1,
        preview: null,
      };
    });
    return Promise.resolve(
      Response.json({ items, nextCursor: uuid(10_000 + served) }),
    );
  });
  const scope = {
    apiClient: createApiClient({ fetch, readCsrfToken: () => undefined }),
    userId,
    workspaceId,
    workflowId,
  };

  const counts = await new QueryClient().fetchQuery(
    stepDiscussionsQuery(scope),
  );

  expect(Object.fromEntries(counts)).toEqual({ check: 50, notify: 50 });
  expect(new Set(limits)).toEqual(new Set(['20']));
});
