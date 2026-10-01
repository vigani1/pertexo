import { HttpResponse, http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { accessibleWorkspaceSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { workflowSummarySchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { WorkflowDuplicateDialog } from '@/features/workflows/duplicate.public';
import { createApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/api-error';
import { workflowKeys } from '@/features/workflows/queries.public';
import { mockServer } from '../../support/mock-server';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import {
  api,
  discoveryHandlers,
  draftBody,
  etag,
  summary,
  userId,
  versionId,
  workflowId,
  workspaceId,
  workspaceWith,
  problem,
} from './workflow-list.fixtures';

function open(
  source: { kind: 'draft' } | { kind: 'version'; versionId: string } = {
    kind: 'draft',
  },
) {
  mockServer.use(
    ...discoveryHandlers(),
    http.get(`${api}/workflows/${workflowId}/draft`, () =>
      HttpResponse.json(draftBody(workflowId), { headers: { etag } }),
    ),
  );
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const result = renderInRouter(
    <WorkflowDuplicateDialog
      apiClient={createApiClient({
        fetch: testFetch,
        readCsrfToken: () =>
          'csrf-token-for-component-tests-12345678901234567890',
      })}
      userId={userId}
      workspace={accessibleWorkspaceSchema.parse(
        workspaceWith(['workflow:create']),
      )}
      workflow={workflowSummarySchema.parse(summary(workflowId, 'Source'))}
      source={source}
      {...(source.kind === 'version' ? { versionNumber: 3 } : {})}
      onCreated={onCreated}
      onClose={onClose}
    />,
  );
  return { ...result, onCreated, onClose, event: userEvent.setup() };
}

interface Attempt {
  body: unknown;
  key: string | null;
  tag: string | null;
}

describe('Duplicate workflow', () => {
  it('keeps the name and source selection through an ordinary conflict', async () => {
    mockServer.use(
      http.post(`${api}/workflows/${workflowId}/duplicate`, () =>
        problem(409, 'request.idempotency_conflict'),
      ),
    );
    const { event, onCreated } = open();
    await screen.findByText(/Source: saved draft revision 1/u);
    await event.clear(screen.getByLabelText('Copy name'));
    await event.type(screen.getByLabelText('Copy name'), 'Keep this intent');
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    expect(
      await screen.findByText(/already used with different details/u),
    ).toBeVisible();
    expect(screen.getByLabelText('Copy name')).toHaveValue('Keep this intent');
    expect(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    ).toBeEnabled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('fences a held accepted result after another source read loses access', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let called = false;
    mockServer.use(
      http.post(`${api}/workflows/${workflowId}/duplicate`, async () => {
        called = true;
        await held;
        return HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event, onCreated, queryClient } = open();
    await screen.findByText(/Source: saved draft revision 1/u);
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await waitFor(() => {
      expect(called).toBe(true);
    });
    const key = workflowKeys.detail(userId, workspaceId, workflowId);
    try {
      await queryClient.query({
        queryKey: key,
        queryFn: () =>
          Promise.reject(
            new ApiError({ kind: 'problem', message: 'Denied', status: 403 }),
          ),
        retry: false,
      });
    } catch {
      /* The observable access loss is the subject of this test. */
    }
    await screen.findByText(/Access changed/u);
    release?.();
    expect(screen.getByLabelText('Copy name')).toBeDisabled();
    expect(screen.getByLabelText('Copy name')).toHaveValue('');
    expect(
      screen.queryByText(/independent, unpublished copy of/u),
    ).not.toBeInTheDocument();
    expect(queryClient.getQueryData(key)).toBeUndefined();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('rechecks current workspace capability before retrying an uncertain copy', async () => {
    let calls = 0;
    mockServer.use(
      http.post(`${api}/workflows/${workflowId}/duplicate`, () => {
        calls++;
        return HttpResponse.error();
      }),
    );
    const { event, onCreated } = open();
    await screen.findByText(/Source: saved draft revision 1/u);
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await screen.findByRole('button', { name: 'Retry exact copy' });
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [workspaceWith([])], nextCursor: null }),
      ),
    );
    await event.click(screen.getByRole('button', { name: 'Retry exact copy' }));
    await screen.findByText(/Access changed/u);
    expect(calls).toBe(1);
    expect(onCreated).not.toHaveBeenCalled();
  });
  it('copies the saved source with a bounded name and authoritative tag, never a browser graph', async () => {
    const requests: Attempt[] = [];
    mockServer.use(
      http.post(
        `${api}/workflows/${workflowId}/duplicate`,
        async ({ request }) => {
          requests.push({
            body: await request.json(),
            key: request.headers.get('Idempotency-Key'),
            tag: request.headers.get('If-Match'),
          });
          return HttpResponse.json({ workflowId: versionId }, { status: 201 });
        },
      ),
    );
    const { event, onCreated } = open();
    expect(
      await screen.findByText(/Source: saved draft revision 1/u),
    ).toBeVisible();
    const input = screen.getByLabelText('Copy name');
    expect(input).toHaveValue('Source (copy)');
    await event.clear(input);
    await event.type(input, '   ');
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    expect(
      await screen.findByText('Name the workflow in 1 to 128 characters.'),
    ).toBeVisible();
    expect(input).toHaveFocus();
    expect(requests).toHaveLength(0);
    await event.clear(input);
    await event.type(input, '  Independent copy  ');
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(versionId);
    });
    expect(requests).toEqual([
      {
        body: { name: 'Independent copy', source: { kind: 'draft' } },
        key: requests[0]?.key,
        tag: etag,
      },
    ]);
    expect(requests[0]?.key).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('retains the exact body, original tag and key after a lost response; cancel and edits cannot replace it', async () => {
    const requests: Attempt[] = [];
    mockServer.use(
      http.post(
        `${api}/workflows/${workflowId}/duplicate`,
        async ({ request }) => {
          requests.push({
            body: await request.json(),
            key: request.headers.get('Idempotency-Key'),
            tag: request.headers.get('If-Match'),
          });
          return requests.length === 1
            ? HttpResponse.error()
            : HttpResponse.json({ workflowId: versionId }, { status: 201 });
        },
      ),
    );
    const { event, onCreated, onClose } = open();
    await screen.findByText(/Source: saved draft revision 1/u);
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Retry exact copy' }),
    ).toBeEnabled();
    expect(screen.getByLabelText('Copy name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await event.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    await event.click(screen.getByRole('button', { name: 'Retry exact copy' }));
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(versionId);
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
  });

  it('reads a changed draft only on explicit refresh and needs a new confirmation/key', async () => {
    const requests: Attempt[] = [];
    const nextTag = `"draft-v1.${'b'.repeat(43)}"`;
    mockServer.use(
      http.post(
        `${api}/workflows/${workflowId}/duplicate`,
        async ({ request }) => {
          requests.push({
            body: await request.json(),
            key: request.headers.get('Idempotency-Key'),
            tag: request.headers.get('If-Match'),
          });
          return requests.length === 1
            ? HttpResponse.json(
                {
                  type: 'urn:pertexo:problem:workflow.revision_conflict',
                  title: 'Changed',
                  status: 412,
                  code: 'workflow.revision_conflict',
                  requestId: 'changed',
                  currentRevision: 2,
                  currentEtag: nextTag,
                },
                {
                  status: 412,
                  headers: { 'content-type': 'application/problem+json' },
                },
              )
            : HttpResponse.json({ workflowId: versionId }, { status: 201 });
        },
      ),
    );
    const { event, onCreated } = open();
    await screen.findByText(/Source: saved draft revision 1/u);
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await screen.findByText(/The saved source changed/u);
    expect(requests).toHaveLength(1);
    mockServer.use(
      http.get(`${api}/workflows/${workflowId}/draft`, () =>
        HttpResponse.json(
          { ...draftBody(workflowId), revision: 2 },
          { headers: { etag: nextTag } },
        ),
      ),
    );
    await event.click(
      screen.getByRole('button', { name: 'Read current saved draft' }),
    );
    await screen.findByText(/Source: saved draft revision 2/u);
    expect(requests).toHaveLength(1);
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(versionId);
    });
    expect(requests[1]?.key).not.toEqual(requests[0]?.key);
    expect(requests[1]?.tag).toEqual(nextTag);
  });

  it('selects an immutable version explicitly without a draft tag', async () => {
    const requests: Attempt[] = [];
    mockServer.use(
      http.post(
        `${api}/workflows/${workflowId}/duplicate`,
        async ({ request }) => {
          requests.push({
            body: await request.json(),
            key: request.headers.get('Idempotency-Key'),
            tag: request.headers.get('If-Match'),
          });
          return HttpResponse.json({ workflowId: versionId }, { status: 201 });
        },
      ),
    );
    const { event, onCreated } = open({ kind: 'version', versionId });
    await screen.findByText(/Source: immutable version v3/u);
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(versionId);
    });
    expect(requests[0]).toEqual({
      body: { name: 'Source (copy)', source: { kind: 'version', versionId } },
      key: requests[0]?.key,
      tag: null,
    });
    expect(requests[0]?.key).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('forgets the command/cache on access loss and never sends an exact retry with another identity', async () => {
    let calls = 0;
    mockServer.use(
      http.post(`${api}/workflows/${workflowId}/duplicate`, () => {
        calls++;
        return HttpResponse.error();
      }),
    );
    const { event, onCreated, queryClient } = open();
    await screen.findByText(/Source: saved draft revision 1/u);
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await screen.findByRole('button', { name: 'Retry exact copy' });
    queryClient.setQueryData(
      ['identity', userId, 'workspace', workspaceId, 'private'],
      { sensitive: true },
    );
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        problem(401, 'auth.unauthenticated'),
      ),
    );
    await event.click(screen.getByRole('button', { name: 'Retry exact copy' }));
    await screen.findByText(/Access changed/u);
    expect(calls).toBe(1);
    expect(onCreated).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData([
        'identity',
        userId,
        'workspace',
        workspaceId,
        'private',
      ]),
    ).toBeUndefined();
  });
});
