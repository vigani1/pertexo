import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http, type JsonBodyType } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import {
  accessibleWorkspaceSchema,
  type WorkflowFolder,
} from '@pertexo/contracts';
import { createApiClient } from '@/lib/api/client';
import { NotificationsProvider } from '@/components/ui/toast';
import { FolderActionDialog } from '@/features/workflows/components/organization/folders/actions';
import { gatewayFailures } from '../../../support/fixtures/gateway-failures';
import { mockServer } from '../../../support/mock-server';
import { testFetch } from '../../../support/render-app';
import {
  api,
  discoveryHandlers,
  problem,
  userId,
  workflowId,
  workspaceWith,
} from '../list/fixtures';
import { installVocabulary, renderTags, tag } from './tags/fixture';

const operations: WorkflowFolder = {
  id: workflowId,
  name: 'Operations',
  parentId: null,
  revision: 2,
  depth: 1,
  accessMode: 'workspace',
};

/**
 * Like the API: a key replays its receipt, and a new rename applies only
 * against the revision it read. The first applied rename loses its response.
 */
function renameServer<Resource extends { revision: number }>({
  initial,
  rename,
  receipt,
  conflictCode,
  gatewayFailure,
}: Readonly<{
  initial: Resource;
  rename: (current: Resource, body: Record<string, unknown>) => Resource;
  receipt: (current: Resource, replayed: boolean) => JsonBodyType;
  conflictCode: string;
  gatewayFailure: () => Response;
}>) {
  const state = { current: initial, applied: 0, requests: 0 };
  const receipts = new Map<string | null, Resource>();
  const handle = async (request: Request) => {
    state.requests += 1;
    const key = request.headers.get('idempotency-key');
    const held = receipts.get(key);
    if (held !== undefined) return HttpResponse.json(receipt(held, true));
    const body = (await request.json()) as Record<string, unknown>;
    const expected = Object.entries(body).find(([field]) =>
      field.startsWith('expected'),
    )?.[1];
    if (expected !== state.current.revision) return problem(409, conflictCode);
    state.current = rename(state.current, body);
    state.applied += 1;
    receipts.set(key, state.current);
    return state.requests === 1
      ? gatewayFailure()
      : HttpResponse.json(receipt(state.current, false));
  };
  return { state, handle };
}

describe('folder and tag renames after a gateway failure', () => {
  it.each(gatewayFailures)(
    'a folder rename lands once when the person saves again after a %s',
    async (_status, gatewayFailure) => {
      const server = renameServer({
        initial: operations,
        rename: (current, body) => ({
          ...current,
          name: String(body.name),
          revision: current.revision + 1,
        }),
        receipt: (folder, replayed) => ({ folder, replayed }),
        conflictCode: 'workflow.folder_revision_conflict',
        gatewayFailure,
      });
      mockServer.use(
        ...discoveryHandlers(),
        http.post(
          `${api}/workflow-folders/${operations.id}/rename`,
          ({ request }) => server.handle(request),
        ),
      );
      const onDone = vi.fn();
      render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <NotificationsProvider>
            <FolderActionDialog
              apiClient={createApiClient({
                fetch: testFetch,
                readCsrfToken: () => 'csrf-token-1234567890',
              })}
              userId={userId}
              workspace={accessibleWorkspaceSchema.parse({
                ...workspaceWith(['workflow:read', 'workflow:update']),
                role: 'owner',
              })}
              folders={[operations]}
              action={{ kind: 'rename', folder: operations }}
              onClose={vi.fn()}
              onDone={onDone}
            />
          </NotificationsProvider>
        </QueryClientProvider>,
      );
      const event = userEvent.setup();
      const field = screen.getByLabelText('Name');
      await event.clear(field);
      await event.type(field, 'Ops');
      await event.click(screen.getByRole('button', { name: 'Save name' }));
      await screen.findByText(/couldn’t confirm/u);

      await event.click(screen.getByRole('button', { name: 'Save name' }));

      expect(await screen.findByText('Folder renamed')).toBeVisible();
      expect(onDone).toHaveBeenCalledOnce();
      expect(screen.queryByText(/folder changed/iu)).not.toBeInTheDocument();
      expect(server.state.requests).toBe(2);
      expect(server.state.applied).toBe(1);
    },
  );

  it.each(gatewayFailures)(
    'a tag rename lands once when the person saves again after a %s',
    async (_status, gatewayFailure) => {
      const server = renameServer({
        initial: tag,
        rename: (current, body) => ({
          ...current,
          key: String(body.key),
          revision: current.revision + 1,
        }),
        receipt: (renamed, replayed) => ({ tag: renamed, replayed }),
        conflictCode: 'workflow.tag_revision_conflict',
        gatewayFailure,
      });
      installVocabulary();
      mockServer.use(
        http.post(`${api}/workflow-tags/${tag.id}/rename`, ({ request }) =>
          server.handle(request),
        ),
      );
      renderTags();
      const event = userEvent.setup();
      await event.click(await screen.findByRole('button', { name: 'ops' }));
      const field = screen.getByLabelText('Rename #ops');
      await event.clear(field);
      await event.type(field, 'operations');
      await event.click(screen.getByRole('button', { name: 'Save name' }));
      await screen.findByText(/couldn’t confirm/u);

      await event.click(screen.getByRole('button', { name: 'Save name' }));

      await waitFor(() => {
        expect(server.state.requests).toBe(2);
      });
      expect(await screen.findByText('Tag renamed')).toBeVisible();
      expect(screen.queryByText(/tag changed/iu)).not.toBeInTheDocument();
      expect(server.state.applied).toBe(1);
    },
  );
});
