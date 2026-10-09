import { QueryClient } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import {
  workflowRunQueryOptions,
  workflowRunsInfiniteQueryOptions,
} from '@/features/workflow-runs/data/workflow-runs.queries';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import { apiBase, fixtureIds, fixtureRun } from '../../support/fixtures/run';

const apiClient = createApiClient({
  fetch: testFetch,
  readCsrfToken: () => undefined,
});
const blocked = fixtureRun(fixtureIds.firstRun, 'queued', {
  admissionBlockers: {
    asOf: '2026-10-01T10:00:00.000000Z',
    reasons: ['workflow_capacity'],
  },
});
function problem(status: number) {
  return HttpResponse.json(
    {
      type: 'https://api.pertexo.test/problems/resource.not_found',
      title: 'Unavailable',
      status,
      code: 'resource.not_found',
      requestId: 'run-admission-read',
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

describe('run snapshot denial with admission projections', () => {
  it.each([403, 404, 409])(
    'forgets detail after %i and does not restore it on transient failure',
    async (status) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const options = workflowRunQueryOptions(
        apiClient,
        fixtureIds.user,
        fixtureIds.workspace,
        fixtureIds.firstRun,
      );
      let response = () => HttpResponse.json({ run: blocked, nodes: [] });
      mockServer.use(
        http.get(`${apiBase}/runs/${fixtureIds.firstRun}`, () => response()),
      );
      await client.query(options);
      response = () => problem(status);
      await expect(client.query(options)).rejects.toBeDefined();
      expect(client.getQueryData(options.queryKey)).toBeUndefined();
      response = () => problem(503);
      await expect(client.query(options)).rejects.toBeDefined();
      expect(client.getQueryData(options.queryKey)).toBeUndefined();
      response = () => HttpResponse.json({ run: blocked, nodes: [] });
      await client.query(options);
      expect(client.getQueryData(options.queryKey)).toMatchObject({
        run: { admissionBlockers: { reasons: ['workflow_capacity'] } },
      });
      client.clear();
    },
  );

  it('forgets sibling history filters before remount, while ordinary transient reads retain authorized history', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const options = workflowRunsInfiniteQueryOptions(
      apiClient,
      fixtureIds.user,
      fixtureIds.workspace,
      {},
    );
    const filtered = workflowRunsInfiniteQueryOptions(
      apiClient,
      fixtureIds.user,
      fixtureIds.workspace,
      { status: 'queued' },
    );
    let response = () =>
      HttpResponse.json({ items: [blocked], nextCursor: null });
    mockServer.use(http.get(`${apiBase}/runs`, () => response()));
    await client.infiniteQuery(options);
    await client.infiniteQuery(filtered);
    response = () => problem(503);
    await expect(client.infiniteQuery(options)).rejects.toBeDefined();
    expect(client.getQueryData(options.queryKey)).toBeDefined();
    response = () => problem(403);
    await expect(client.infiniteQuery(options)).rejects.toBeDefined();
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    expect(client.getQueryData(filtered.queryKey)).toBeUndefined();
    response = () => problem(503);
    await expect(client.infiniteQuery(filtered)).rejects.toBeDefined();
    expect(client.getQueryData(filtered.queryKey)).toBeUndefined();
    response = () => HttpResponse.json({ items: [blocked], nextCursor: null });
    await client.infiniteQuery(filtered);
    expect(client.getQueryData(filtered.queryKey)).toBeDefined();
    client.clear();
  });
});
