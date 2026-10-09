import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { unpausedWorkflowSettings } from './fixtures/auto-pause';
import { defaultConcurrencySettings } from './fixtures/concurrency';

export const mockServer = setupServer(
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
