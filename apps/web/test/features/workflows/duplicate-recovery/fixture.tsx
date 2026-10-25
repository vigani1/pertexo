import { WorkflowDuplicateDialog } from '@/features/workflows/creation/duplicate.public';
import { createApiClient } from '@/lib/api/client';
import {
  accessibleWorkspaceSchema,
  workflowSummarySchema,
} from '@pertexo/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, vi } from 'vitest';
import { mockServer } from '../../../support/mock-server';
import { testFetch } from '../../../support/render-app';
import { renderInRouter } from '../../../support/render-in-router';
import {
  api,
  discoveryHandlers,
  draftBody,
  etag,
  problem,
  summary,
  userId,
  versionId,
  workflowId,
  workspaceWith,
} from '../list/fixtures';
export function open() {
  mockServer.use(
    ...discoveryHandlers(),
    http.get(`${api}/workflows/${workflowId}/draft`, () =>
      HttpResponse.json(draftBody(workflowId), { headers: { etag } }),
    ),
  );
  const onCreated = vi.fn();
  const view = renderInRouter(
    <WorkflowDuplicateDialog
      workflow={workflowSummarySchema.parse(summary(workflowId, 'Source'))}
      source={{ kind: 'draft' }}
      onCreated={onCreated}
      onClose={vi.fn()}
      scope={{
        apiClient: createApiClient({
          fetch: testFetch,
          readCsrfToken: () =>
            'csrf-token-for-component-tests-12345678901234567890',
        }),
        userId,
        workspace: accessibleWorkspaceSchema.parse(
          workspaceWith(['workflow:create']),
        ),
      }}
    />,
  );
  return { ...view, onCreated, event: userEvent.setup() };
}

export const identityUrl = 'http://pertexo.test/v1/users/me';

const workspaceUrl = 'http://pertexo.test/v1/workspaces';

export const created = () =>
  HttpResponse.json({ workflowId: versionId }, { status: 201 });

export const transient = (status: number) =>
  problem(status, 'platform.unavailable');

export const nextTag = `"draft.${'b'.repeat(43)}"`;

export const staleResponse = () =>
  HttpResponse.json(
    {
      type: 'urn:pertexo:problem:workflow.revision_conflict',
      title: 'Changed',
      status: 412,
      code: 'workflow.revision_conflict',
      requestId: 'fixture-stale',
      currentRevision: 2,
      currentEtag: nextTag,
    },
    { status: 412, headers: { 'content-type': 'application/problem+json' } },
  );

export const outages = [
  {
    label: 'identity network failure',
    url: identityUrl,
    response: () => HttpResponse.error(),
  },
  { label: 'workspace 429', url: workspaceUrl, response: () => transient(429) },
  { label: 'workspace 503', url: workspaceUrl, response: () => transient(503) },
  { label: 'workspace read 412', url: workspaceUrl, response: staleResponse },
];

export function captureCopies(response: (count: number) => Response) {
  const requests: { body: unknown; key: string | null; tag: string | null }[] =
    [];
  mockServer.use(
    http.post(
      `${api}/workflows/${workflowId}/duplicate`,
      async ({ request }) => {
        requests.push({
          body: await request.json(),
          key: request.headers.get('Idempotency-Key'),
          tag: request.headers.get('If-Match'),
        });
        return response(requests.length);
      },
    ),
  );
  return requests;
}

export async function expectRecovery() {
  expect(
    await screen.findByRole('button', { name: 'Retry exact copy' }),
  ).toBeEnabled();
  expect(screen.getByLabelText('Copy name')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(screen.queryByText(/Nothing was changed/u)).not.toBeInTheDocument();
}
