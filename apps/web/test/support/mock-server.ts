import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { unpausedWorkflowSettings } from './auto-pause-fixtures';
import { defaultConcurrencySettings } from './concurrency-fixtures';

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
);
