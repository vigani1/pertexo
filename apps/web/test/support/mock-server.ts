import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { unpausedWorkflowSettings } from './fixtures/auto-pause';
import { defaultConcurrencySettings } from './fixtures/concurrency';

export const mockServer = setupServer(
  http.get(
    'http://pertexo.test/v1/workspaces/:workspaceId/workflows/:workflowId/publication-review',
    () => HttpResponse.json({ required: false, request: null }),
  ),
  http.get(
    'http://pertexo.test/v1/workspaces/:workspaceId/workflows/:workflowId/draft/test-suites',
    () =>
      HttpResponse.json({
        current: {
          signature: '0'.repeat(64),
          draftRevision: 1,
          variableSetRevision: null,
          samples: [],
          cases: [],
        },
        items: [],
      }),
  ),
  http.get('http://pertexo.test/v1/workspaces/:workspaceId/notifications', () =>
    HttpResponse.json({ items: [], nextCursor: null, revision: '0' }),
  ),
  http.get(
    'http://pertexo.test/v1/workspaces/:workspaceId/notifications/summary',
    () => HttpResponse.json({ unreadCount: 0, revision: '0' }),
  ),
  http.get(
    'http://pertexo.test/v1/workspaces/:workspaceId/notifications/events',
    () =>
      new HttpResponse(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: inbox.ready\ndata: {"revision":null}\n\n',
              ),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  ),
  http.get('http://pertexo.test/v1/workspaces/:workspaceId/pending-tasks', () =>
    HttpResponse.json({ items: [], nextCursor: null, pendingCount: 0 }),
  ),
  http.get(
    'http://pertexo.test/v1/workspaces/:workspaceId/pending-tasks/audience',
    () => HttpResponse.json({ items: [], nextCursor: null }),
  ),
  http.get(
    'http://pertexo.test/v1/workspaces/:workspaceId/workflows/:workflowId/error-workflow',
    () => HttpResponse.json({ targetWorkflowId: null, revision: 1 }),
  ),
  http.get(
    'http://pertexo.test/v1/workspaces/:workspaceId/workflows/:workflowId/error-workflow/targets',
    () => HttpResponse.json({ items: [], nextCursor: null }),
  ),
  http.get(
    'http://pertexo.test/v1/workspaces/:workspaceId/workflows/:workflowId/concurrency',
    () => HttpResponse.json(defaultConcurrencySettings),
  ),
  http.get(
    'http://pertexo.test/v1/workspaces/:workspaceId/workflows/:workflowId/auto-pause',
    () => HttpResponse.json(unpausedWorkflowSettings),
  ),
  http.get('http://pertexo.test/v1/workspaces/:workspaceId/auto-pause', () =>
    HttpResponse.json({ threshold: 10, revision: 1 }),
  ),
  // Every workflow list reads its folders and tags; most tests have none.
  http.get(
    'http://pertexo.test/v1/workspaces/:workspaceId/workflow-folders',
    () => HttpResponse.json({ items: [] }),
  ),
  http.get('http://pertexo.test/v1/workspaces/:workspaceId/workflow-tags', () =>
    HttpResponse.json({ items: [], nextCursor: null }),
  ),
);
