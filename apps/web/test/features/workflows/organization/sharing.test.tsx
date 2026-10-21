import { useFolderSharingEditor } from '@/features/workflows/hooks/use-folder-sharing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { expect, it, vi } from 'vitest';
import type { FolderSharing } from '@pertexo/contracts';
import { FolderSharingPanel } from '@/features/workflows/components/organization/folders/sharing';
import { AudienceMoveReview } from '@/features/workflows/components/organization/folders/audience-review';
import { useAudienceMove } from '@/features/workflows/hooks/use-audience-move';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../../support/mock-server';
import { testFetch } from '../../../support/render-app';
import {
  api,
  userId,
  workspaceId,
  workflowId,
  secondWorkflowId,
  discoveryHandlers,
} from '../list/fixtures';
const apiClient = createApiClient({
  fetch: testFetch,
  readCsrfToken: () => 'csrf-token-1234567890',
});
function SharingHarness() {
  const scope = { apiClient, userId, workspaceId };
  const editor = useFolderSharingEditor(scope, workflowId);
  return (
    <>
      <FolderSharingPanel scope={scope} name="Finance" editor={editor} />
      <output aria-label="Sharing command">
        {editor.closeLocked ? 'locked' : 'ready'}
      </output>
    </>
  );
}
function setup() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const initial: FolderSharing = {
    folderId: workflowId,
    revision: 1,
    mode: 'restricted',
    grants: [{ kind: 'member', userId: secondWorkflowId, access: 'viewer' }],
    labels: { [secondWorkflowId]: 'Finance reviewer' },
  };
  let current = initial;
  mockServer.use(
    ...discoveryHandlers(),
    http.get(`${api}/workflow-folders/${workflowId}/sharing`, () =>
      HttpResponse.json(current),
    ),
    http.get(`${api}/resource-sharing-principals`, () =>
      HttpResponse.json({
        items: [{ kind: 'member', userId, label: 'Jane' }],
        next: null,
      }),
    ),
  );
  render(
    <QueryClientProvider client={cache}>
      <SharingHarness />
    </QueryClientProvider>,
  );
  return {
    cache,
    update: (next: FolderSharing) => {
      current = next;
    },
    initial,
  };
}
it('shows current principal labels and keeps local grant edits across a newer sharing refetch until explicit reload', async () => {
  const event = userEvent.setup();
  const f = setup();
  await screen.findByText('Finance reviewer');
  await event.click(await screen.findByRole('button', { name: 'Add Jane' }));
  expect(
    screen.getByText('2 of 100 sharing entries.', { exact: false }),
  ).toBeInTheDocument();
  f.update({ ...f.initial, revision: 2 });
  await act(async () => {
    await f.cache.refetchQueries({
      predicate: (query) => query.queryKey.includes('folder-sharing'),
    });
  });
  expect(
    await screen.findByText('Sharing changed while this form was open.', {
      exact: false,
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Remove Jane' }),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save sharing' })).toBeDisabled();
  await event.click(
    screen.getByRole('button', { name: 'Discard edits and reload sharing' }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Remove Jane' }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole('button', { name: 'Save sharing' })).toBeEnabled();
});
it('keeps unsaved grants through a temporary read failure and only discards them on an explicit successful reload', async () => {
  const event = userEvent.setup();
  const f = setup();
  await event.click(await screen.findByRole('button', { name: 'Add Jane' }));
  mockServer.use(
    http.get(
      `${api}/workflow-folders/${workflowId}/sharing`,
      () => new HttpResponse(null, { status: 503 }),
    ),
  );
  await act(async () => {
    await f.cache.refetchQueries({
      predicate: (query) => query.queryKey.includes('folder-sharing'),
    });
  });
  expect(
    screen.getByRole('button', { name: 'Remove Jane' }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save sharing' })).toBeDisabled(),
  );
  await event.click(
    screen.getByRole('button', { name: 'Discard edits and reload sharing' }),
  );
  expect(
    screen.getByRole('button', { name: 'Remove Jane' }),
  ).toBeInTheDocument();
  mockServer.use(
    http.get(`${api}/workflow-folders/${workflowId}/sharing`, () =>
      HttpResponse.json(f.initial),
    ),
  );
  await event.click(
    screen.getByRole('button', { name: 'Discard edits and reload sharing' }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Remove Jane' }),
    ).not.toBeInTheDocument(),
  );
});
it('retains the exact sharing body and idempotency key after an uncertain response', async () => {
  const requests: { key: string | null; body: unknown }[] = [];
  const f = setup();
  mockServer.use(
    http.post(
      `${api}/workflow-folders/${workflowId}/sharing`,
      async ({ request }) => {
        const body: unknown = await request.json();
        requests.push({ key: request.headers.get('idempotency-key'), body });
        return requests.length === 1
          ? HttpResponse.error()
          : HttpResponse.json({ ...f.initial, revision: 2, replayed: true });
      },
    ),
  );
  const event = userEvent.setup();
  await event.click(
    await screen.findByRole('button', { name: 'Save sharing' }),
  );
  await screen.findByRole('button', { name: 'Retry exact sharing change' });
  expect(screen.getByLabelText('Sharing command')).toHaveTextContent('locked');
  expect(
    screen.getByRole('button', { name: 'Discard edits and reload sharing' }),
  ).toBeDisabled();
  await event.click(
    screen.getByRole('button', { name: 'Retry exact sharing change' }),
  );
  await waitFor(() => {
    expect(requests).toHaveLength(2);
  });
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]?.body).toEqual({
    mode: 'restricted',
    expectedFolderRevision: 1,
    grants: f.initial.grants,
  });
});
function MoveHarness({ send }: { send: (input: unknown) => void }) {
  const move = useAudienceMove(apiClient, workspaceId, send);
  return (
    <>
      <button
        onClick={() => {
          void move.begin({
            kind: 'place-folder',
            workspaceId,
            workflowId,
            idempotencyKey: 'reviewed-move',
            body: { folderId: null, expectedOrganizationRevision: 3 },
          });
        }}
      >
        Move out
      </button>
      {move.review ? (
        <AudienceMoveReview
          report={move.review.report}
          administrator
          pending={false}
          onCancel={move.cancel}
          onConfirm={() => {
            void move.confirm();
          }}
        />
      ) : null}
    </>
  );
}
it('does not send an audience-changing move before an unchecked acknowledgement and carries its exact review token', async () => {
  mockServer.use(
    http.post(`${api}/workflow-folders/review-move`, () =>
      HttpResponse.json({
        items: [
          {
            id: workflowId,
            requiresReview: true,
            token: 'b'.repeat(64),
            removedRestrictions: [
              { id: secondWorkflowId, name: 'Restricted Finance' },
            ],
          },
        ],
      }),
    ),
  );
  const send = vi.fn();
  render(<MoveHarness send={send} />);
  const event = userEvent.setup();
  await event.click(screen.getByRole('button', { name: 'Move out' }));
  const review = await screen.findByRole('region', {
    name: 'Review audience change',
  });
  expect(within(review).getByText('Restricted Finance')).toBeInTheDocument();
  const confirm = within(review).getByRole('button', {
    name: 'Confirm move and audience change',
  });
  expect(confirm).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
  await event.click(within(review).getByRole('checkbox'));
  await event.click(confirm);
  await waitFor(() => {
    expect(send).toHaveBeenCalledOnce();
  });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      body: {
        folderId: null,
        expectedOrganizationRevision: 3,
        audienceReview: { token: 'b'.repeat(64), acknowledge: true },
      },
    }),
  );
});
