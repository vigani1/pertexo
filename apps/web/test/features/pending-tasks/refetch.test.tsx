import { File as NodeFile } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
import {
  taskKeys,
  taskQueryOptions,
} from '@/features/pending-tasks/data/tasks.queries';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import {
  identityHandlers,
  ownerWorkspace,
  user,
  userId,
  workspaceId,
} from '../../support/fixtures/team';
import { fixtureRun } from '../../support/fixtures/run';
import { base, detail, summary, taskId } from './fixtures';

it.each(['approval', 'input_request'] as const)(
  'keeps an unsaved %s response across a failed detail refresh',
  async (kind) => {
    let failing = false;
    const task = detail(kind);
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      http.get(base, () =>
        HttpResponse.json({ items: [], nextCursor: null, pendingCount: 0 }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/runs/${task.runId}`,
        () =>
          HttpResponse.json({
            run: fixtureRun(task.runId, 'waiting'),
            nodes: [],
          }),
      ),
      http.get(`${base}/${taskId}`, () =>
        failing ? HttpResponse.error() : HttpResponse.json({ task }),
      ),
    );
    const app = await renderLoadedApp(`/w/${workspaceId}/requests/${taskId}`);
    const scope = { apiClient: app.apiClient, userId, workspaceId };
    const actor = userEvent.setup();
    const label = kind === 'approval' ? 'Comment (optional)' : 'Reason';
    const field = await screen.findByLabelText(label);
    await actor.type(field, 'Do not lose this response');
    failing = true;
    await act(async () => {
      await app.queryClient.invalidateQueries({
        queryKey: taskQueryOptions(scope, taskId).queryKey,
      });
    });
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByLabelText(label)).toBe(field);
    expect(field).toHaveValue('Do not lose this response');
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t refresh');
    failing = false;
    await actor.click(retry);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });
    expect(screen.getByLabelText(label)).toBe(field);
    expect(field).toHaveValue('Do not lose this response');
  },
);
it('keeps a pending list decision and its exact retry across a failed background read', async () => {
  let failing = false;
  const writes: { key: string | null; body: unknown }[] = [];
  const task = detail();
  const item = summary();
  mockServer.use(
    ...identityHandlers(ownerWorkspace),
    http.get(base, () =>
      failing
        ? HttpResponse.error()
        : HttpResponse.json({
            items: writes.length >= 2 ? [] : [item],
            nextCursor: null,
            pendingCount: writes.length >= 2 ? 0 : 1,
          }),
    ),
    http.post(`${base}/${taskId}/decide`, async ({ request }) => {
      writes.push({
        key: request.headers.get('idempotency-key'),
        body: await request.json(),
      });
      if (writes.length === 1) return HttpResponse.error();
      const decidedAt = new Date().toISOString();
      return HttpResponse.json({
        task: {
          ...task,
          status: 'approved',
          completedAt: decidedAt,
          completedByName: user.displayName,
          canRespond: false,
          blockedReason: 'resolved',
          output: {
            decision: 'approved',
            comment: '',
            decidedBy: userId,
            decidedAt,
          },
        },
        replayed: true,
      });
    }),
  );
  const app = await renderLoadedApp(`/w/${workspaceId}/requests`);
  const actor = userEvent.setup();
  await actor.click(
    await screen.findByRole('button', { name: 'Approve Review payment' }),
  );
  const decisionRetry = await screen.findByRole('button', {
    name: 'Retry same decision',
  });
  failing = true;
  await act(async () => {
    await app.queryClient.invalidateQueries({
      queryKey: taskKeys.scope(userId, workspaceId),
    });
  });
  const retryRead = await screen.findByRole('button', { name: 'Retry' });
  expect(screen.queryByRole('button', { name: 'Retry same decision' })).toBe(
    decisionRetry,
  );
  failing = false;
  await actor.click(retryRead);
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
  await actor.click(decisionRetry);
  await waitFor(() => {
    expect(writes).toHaveLength(2);
  });
  expect(writes[1]).toEqual(writes[0]);
});

it.each([
  ['Manager sign-off', 'at step Manager sign-off'],
  [null, 'Reviewer flow'],
])('names the step, never its id: %s', async (stepName, shown) => {
  const task = {
    ...detail('approval'),
    workflowName: 'Reviewer flow',
    stepName,
  };
  mockServer.use(
    ...identityHandlers(ownerWorkspace),
    http.get(base, () =>
      HttpResponse.json({ items: [], nextCursor: null, pendingCount: 0 }),
    ),
    http.get(`${base}/${taskId}`, () => HttpResponse.json({ task })),
  );
  await renderLoadedApp(`/w/${workspaceId}/requests/${taskId}`);
  const line = await screen.findByText(new RegExp(shown));
  expect(line.closest('p')?.textContent).not.toContain(task.nodeId);
});

it('tells a task responder to upload again when finalization expires', async () => {
  const task = {
    ...detail('input_request'),
    fields: [
      {
        id: 'invoice',
        name: 'invoice',
        label: 'Invoice',
        type: 'file',
        accept: ['documents'],
      },
    ],
  };
  const uploadId = '55555555-5555-4555-8555-555555555555';
  const store = 'https://objects.example.test/task-file';
  mockServer.use(
    ...identityHandlers(ownerWorkspace),
    http.get(`${base}/${taskId}`, () => HttpResponse.json({ task })),
    http.post(`${base}/${taskId}/uploads`, () =>
      HttpResponse.json({
        upload: {
          id: uploadId,
          filename: 'invoice.pdf',
          byteLength: 9,
          mediaType: 'application/pdf',
          status: 'pending',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
        transfer: {
          method: 'PUT',
          url: store,
          headers: {},
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          expiresInSeconds: 900,
        },
        replayed: false,
      }),
    ),
    http.put(store, () => new HttpResponse(null, { status: 200 })),
    http.post(`${base}/${taskId}/uploads/${uploadId}/finalize`, () =>
      HttpResponse.json(
        {
          type: 'urn:pertexo:problem:artifact.upload_unavailable',
          title: 'Upload no longer available',
          status: 404,
          code: 'artifact.upload_unavailable',
          detail:
            'This upload expired or is no longer available. Upload the file again.',
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
        {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    ),
  );
  await renderLoadedApp(`/w/${workspaceId}/requests/${taskId}`);
  const field = await screen.findByLabelText('Invoice');
  await userEvent
    .setup()
    .upload(
      field,
      new NodeFile(['%PDF-1.7\n'], 'invoice.pdf') as unknown as File,
    );
  expect(
    await within(
      await screen.findByRole('list', { name: 'Invoice files' }),
    ).findByText(
      /This upload expired or is no longer available\. Upload the file again\./u,
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Retry invoice.pdf' }),
  ).not.toBeInTheDocument();
});

it.each([
  [
    'pending_task.expired',
    'This request expired. Refresh to see its current state.',
  ],
  [
    'pending_task.already_resolved',
    'Someone already responded. Refresh to see the recorded decision.',
  ],
] as const)(
  'explains a definite %s decision refusal without losing the comment',
  async (code, message) => {
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      http.get(base, () =>
        HttpResponse.json({ items: [], nextCursor: null, pendingCount: 0 }),
      ),
      http.get(`${base}/${taskId}`, () =>
        HttpResponse.json({ task: detail() }),
      ),
      http.post(`${base}/${taskId}/decide`, () =>
        HttpResponse.json(
          {
            type: `urn:pertexo:problem:${code}`,
            title: 'Task unavailable',
            status: 409,
            code,
            requestId: 'task-refusal',
          },
          {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
      ),
    );
    await renderLoadedApp(`/w/${workspaceId}/requests/${taskId}`);
    const actor = userEvent.setup();
    const comment = await screen.findByLabelText('Comment (optional)');
    await actor.type(comment, 'My decision context');
    await actor.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(message)).toBeVisible();
    expect(comment).toHaveValue('My decision context');
    expect(
      screen.queryByRole('button', { name: 'Retry same decision' }),
    ).not.toBeInTheDocument();
  },
);

it('shows an approval beside the waiting list with who decides and what each answer does', async () => {
  const task = detail('approval');
  mockServer.use(
    ...identityHandlers(ownerWorkspace),
    http.get(base, () =>
      HttpResponse.json({
        items: [summary()],
        nextCursor: null,
        pendingCount: 1,
      }),
    ),
    http.get(`${base}/${taskId}`, () => HttpResponse.json({ task })),
  );
  await renderLoadedApp(`/w/${workspaceId}/requests/${taskId}`);
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Review payment' }),
  ).toBeVisible();
  const who = screen.getByRole('region', { name: 'Who decides' });
  expect(who).toHaveTextContent(
    'It went to owners and admins. The first decision counts. You can answer it.',
  );
  const outcomes = screen.getByRole('region', {
    name: 'What each answer does',
  });
  expect(outcomes).toHaveTextContent(
    'ApproveThe run carries on along the step’s Approved path.',
  );
  expect(outcomes).toHaveTextContent(
    'this step fails. A failure route takes over if the workflow has one.',
  );
  // The list beside it marks this request as the open one.
  const list = screen.getByRole('list', { name: 'Requests' });
  expect(
    within(list).getByRole('link', { name: 'Review payment' }),
  ).toHaveAttribute('aria-current', 'page');
});
