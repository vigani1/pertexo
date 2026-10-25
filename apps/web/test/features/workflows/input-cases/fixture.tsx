import { createApiClient } from '@/lib/api/client';
import {
  accessibleWorkspaceSchema,
  workflowSummarySchema,
} from '@pertexo/contracts';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { mockServer } from '../../../support/mock-server';
import { testFetch } from '../../../support/render-app';
import { renderInRouter } from '../../../support/render-in-router';
import {
  api,
  discoveryHandlers,
  summary,
  userId,
  versionId,
  workflowId,
  workspaceId,
  workspaceWith,
} from '../list/fixtures';
import { CaseBrowser } from './browsers';
export const caseId = '34343434-3434-4343-8343-343434343434';

export const path = `${api}/workflows/${workflowId}/input-cases`;

export const metadata = {
  id: caseId,
  workspaceId,
  workflowId,
  workflowVersionId: versionId,
  versionChecksum: `wf:sha256:${'a'.repeat(64)}`,
  name: 'Synthetic customer',
  revision: 1,
  representationTag: `"wic1.${caseId.replaceAll('-', '')}.1"`,
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
};

export function open(canWrite = true) {
  mockServer.use(
    ...discoveryHandlers(canWrite ? ['workflow:update'] : ['run:start']),
    http.get(path, () => HttpResponse.json({ items: [metadata] })),
    http.get(`${path}/${caseId}`, () =>
      HttpResponse.json(
        { case: { ...metadata, input: { customer: 'synthetic' } } },
        { headers: { ETag: metadata.representationTag } },
      ),
    ),
  );
  const onLoad = vi.fn();
  const result = renderInRouter(
    <CaseBrowser
      apiClient={createApiClient({
        fetch: testFetch,
        readCsrfToken: () =>
          'csrf-token-for-component-tests-12345678901234567890',
      })}
      userId={userId}
      onLoad={onLoad}
      scope={{
        workspace: accessibleWorkspaceSchema.parse(
          workspaceWith(canWrite ? ['workflow:update'] : ['run:start']),
        ),
        workflow: workflowSummarySchema.parse(
          summary(workflowId, 'Case workflow', {
            publishedVersionId: versionId,
          }),
        ),
      }}
    />,
  );
  return { ...result, onLoad, event: userEvent.setup() };
}
