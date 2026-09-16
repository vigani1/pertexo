import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getAllConnections } from '@/features/connections/connections.api';
import { getAllWorkflowVersions } from '@/features/workflow-versions/public';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../support/mock-server';
import { testFetch } from '../support/render-app';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('bounded paginated discovery', () => {
  it('loads connections beyond the first 100-item page', async () => {
    const connection = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      workspaceId,
      providerKey: 'http',
      name: 'Page two API',
      authType: 'http_headers',
      status: 'active',
      secretVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
      createdAt: '2026-09-15T10:00:00.000Z',
      updatedAt: '2026-09-15T10:00:00.000Z',
    };
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        ({ request }) =>
          HttpResponse.json(
            new URL(request.url).searchParams.get('after') === null
              ? { items: [], nextCursor: 'page-two' }
              : { items: [connection], nextCursor: null },
          ),
      ),
    );
    const result = await getAllConnections(client(), workspaceId);
    expect(result.items).toEqual([connection]);
    expect(result.nextCursor).toBeNull();
  });

  it('loads immutable versions beyond the first 25-item page', async () => {
    const version = {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      workflowId,
      versionNumber: 1,
      schemaVersion: 1,
      graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
      checksum: `wf:v1:sha256:${'a'.repeat(64)}`,
      publishedAt: '2026-09-15T10:00:00.000Z',
    };
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions`,
        ({ request }) =>
          HttpResponse.json(
            new URL(request.url).searchParams.get('after') === null
              ? { items: [], nextCursor: 'page-two' }
              : { items: [version], nextCursor: null },
          ),
      ),
    );
    const result = await getAllWorkflowVersions(
      client(),
      workspaceId,
      workflowId,
    );
    expect(result.items).toEqual([version]);
    expect(result.nextCursor).toBeNull();
  });
});

function client() {
  return createApiClient({
    fetch: testFetch,
    readCsrfToken: () => undefined,
  });
}
