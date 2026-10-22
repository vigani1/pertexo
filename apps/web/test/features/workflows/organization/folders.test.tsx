import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import {
  accessibleWorkspaceSchema,
  type WorkflowFolder,
} from '@pertexo/contracts';
import { createApiClient } from '../../../../src/lib/api/client';
import { NotificationsProvider } from '../../../../src/components/ui/toast';
import {
  FolderShelf,
  type FolderAction,
} from '../../../../src/features/workflows/components/organization/folders/shelf';
import { FolderActionDialog } from '../../../../src/features/workflows/components/organization/folders/actions';
import { WorkflowFolderPicker } from '../../../../src/features/workflows/components/organization/folders/picker';
import { mockServer } from '../../../support/mock-server';
import { testFetch } from '../../../support/render-app';
import {
  api,
  userId,
  workflowId,
  secondWorkflowId,
  workspaceWith,
  discoveryHandlers,
  problem,
} from '../list/fixtures';

const operations: WorkflowFolder = {
  id: workflowId,
  name: 'Operations',
  parentId: null,
  revision: 2,
  depth: 1,
  accessMode: 'workspace',
};
const finance: WorkflowFolder = {
  id: secondWorkflowId,
  name: 'Finance',
  parentId: null,
  revision: 4,
  depth: 1,
  accessMode: 'restricted',
};
const invoices: WorkflowFolder = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  name: 'Invoices',
  parentId: finance.id,
  revision: 1,
  depth: 2,
  accessMode: 'workspace',
};
const folders = [operations, finance, invoices];

function renderAction(action: FolderAction) {
  mockServer.use(...discoveryHandlers());
  const workspace = accessibleWorkspaceSchema.parse({
    ...workspaceWith(['workflow:read', 'workflow:update']),
    role: 'owner',
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const apiClient = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-1234567890',
  });
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <NotificationsProvider>
        <FolderActionDialog
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          folders={folders}
          action={action}
          onClose={onClose}
          onDone={onDone}
        />
      </NotificationsProvider>
    </QueryClientProvider>,
  );
  return { onClose, onDone };
}

describe('folder shelf', () => {
  it('shows the top level by name, marks restricted folders and opens one', async () => {
    const onOpen = vi.fn();
    render(
      <FolderShelf
        folders={folders}
        currentFolderId={undefined}
        canManage={false}
        onOpen={onOpen}
        onAction={vi.fn()}
      />,
    );
    const shelf = screen.getByRole('region', { name: 'Folders' });
    const tiles = within(shelf).getAllByRole('listitem');
    expect(tiles.map((tile) => tile.textContent)).toEqual([
      'Finance',
      'Operations',
    ]);
    const [first] = tiles;
    if (first === undefined) throw new Error('Expected a folder tile');
    expect(
      within(first).getByRole('img', {
        name: 'Only chosen people',
      }),
    ).toBeVisible();
    // People who can't manage folders get no folder actions.
    expect(
      screen.queryByRole('button', { name: /^Actions for/u }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Finance/u }));
    expect(onOpen).toHaveBeenCalledWith(finance.id);
  });

  it('inside a folder, draws the way back and offers its actions to admins', async () => {
    const onOpen = vi.fn();
    const onAction = vi.fn();
    render(
      <FolderShelf
        folders={folders}
        currentFolderId={invoices.id}
        canManage
        onOpen={onOpen}
        onAction={onAction}
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'Invoices', level: 2 }),
    ).toBeVisible();
    const path = screen.getByRole('navigation', { name: 'Folder path' });
    await userEvent.click(
      within(path).getByRole('button', { name: 'Finance' }),
    );
    expect(onOpen).toHaveBeenLastCalledWith(finance.id);
    await userEvent.click(
      within(path).getByRole('button', { name: 'All workflows' }),
    );
    expect(onOpen).toHaveBeenLastCalledWith(null);
    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(onAction).toHaveBeenLastCalledWith({
      kind: 'share',
      folder: invoices,
    });
    await userEvent.click(screen.getByRole('button', { name: 'New folder' }));
    expect(onAction).toHaveBeenLastCalledWith({
      kind: 'create',
      parent: invoices,
    });
  });
});

describe('folder dialogs', () => {
  it('validates the name on submit, then sends it trimmed with real progress', async () => {
    let release: (() => void) | undefined;
    const sent: { body: unknown; key: string | null }[] = [];
    const { onDone } = renderAction({ kind: 'create', parent: null });
    mockServer.use(
      http.post(`${api}/workflow-folders`, async ({ request }) => {
        sent.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json({ folder: operations, replayed: false });
      }),
    );
    const event = userEvent.setup();
    const field = screen.getByLabelText('Name');
    // Opening lands on the name, not on Close.
    await waitFor(() => {
      expect(field).toHaveFocus();
    });
    await event.click(screen.getByRole('button', { name: 'Create folder' }));
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter a folder name.')).toBeVisible();
    expect(sent).toHaveLength(0);
    await event.type(field, ' New team ');
    await event.click(screen.getByRole('button', { name: 'Create folder' }));
    const creating = await screen.findByRole('button', { name: 'Creating…' });
    expect(creating).toHaveAttribute('data-pending');
    await waitFor(() => {
      expect(release).toBeDefined();
    });
    release?.();
    await screen.findByText('Folder created');
    expect(onDone).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ name: 'New team', parentId: null });
    expect(typeof sent[0]?.key).toBe('string');
  });

  it('locks an uncertain rename and retries the same revision, body and key', async () => {
    const sent: { body: unknown; key: string | null }[] = [];
    const { onDone } = renderAction({ kind: 'rename', folder: operations });
    mockServer.use(
      http.post(
        `${api}/workflow-folders/${operations.id}/rename`,
        async ({ request }) => {
          sent.push({
            body: await request.json(),
            key: request.headers.get('idempotency-key'),
          });
          return sent.length === 1
            ? HttpResponse.error()
            : HttpResponse.json({
                folder: { ...operations, name: 'Ops', revision: 3 },
                replayed: true,
              });
        },
      ),
    );
    const event = userEvent.setup();
    const field = screen.getByLabelText('Name');
    await event.clear(field);
    await event.type(field, 'Ops');
    await event.click(screen.getByRole('button', { name: 'Save name' }));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(field).toBeDisabled();
    expect(screen.getByText(/won’t be applied twice/u)).toBeVisible();
    await event.click(retry);
    await screen.findByText('Folder renamed');
    expect(onDone).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0]?.body).toEqual({ name: 'Ops', expectedFolderRevision: 2 });
  });

  it('asks before deleting, sends nothing on cancel, and explains a folder that is not empty', async () => {
    const sent = vi.fn();
    const { onClose } = renderAction({ kind: 'delete', folder: operations });
    mockServer.use(
      http.post(`${api}/workflow-folders/${operations.id}/delete`, () => {
        sent();
        return problem(409, 'workflow.folder_not_empty');
      }),
    );
    const event = userEvent.setup();
    const confirmation = screen.getByRole('dialog', {
      name: 'Delete Operations?',
    });
    await event.click(
      within(confirmation).getByRole('button', { name: 'Cancel' }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(sent).not.toHaveBeenCalled();
    await event.click(
      within(confirmation).getByRole('button', { name: 'Delete folder' }),
    );
    await screen.findByText(
      'Move the workflows and child folders out before deleting this folder.',
    );
    expect(sent).toHaveBeenCalledOnce();
  });

  it('moves a folder only to a place outside itself, reviewing an access change first', async () => {
    const moved: unknown[] = [];
    renderAction({ kind: 'move', folder: finance });
    mockServer.use(
      http.post(`${api}/workflow-folders/review-move`, () =>
        HttpResponse.json({
          items: [
            {
              id: finance.id,
              requiresReview: true,
              token: 'c'.repeat(64),
              removedRestrictions: [{ id: finance.id, name: 'Finance' }],
            },
          ],
        }),
      ),
      http.post(
        `${api}/workflow-folders/${finance.id}/move`,
        async ({ request }) => {
          moved.push(await request.json());
          return HttpResponse.json({
            folder: { ...finance, parentId: operations.id, depth: 2 },
            replayed: false,
          });
        },
      ),
    );
    const event = userEvent.setup();
    const picker = screen.getByRole('combobox', { name: 'Move to' });
    picker.focus();
    await event.keyboard('{ArrowDown}');
    // Finance can't move into itself or into Invoices, inside it.
    expect(
      screen.queryByRole('option', { name: /Invoices/u }),
    ).not.toBeInTheDocument();
    await event.click(
      await screen.findByRole('option', { name: 'Operations' }),
    );
    await event.click(screen.getByRole('button', { name: 'Move folder' }));
    const review = await screen.findByRole('region', {
      name: 'Review audience change',
    });
    expect(moved).toHaveLength(0);
    await event.click(within(review).getByRole('checkbox'));
    await event.click(
      within(review).getByRole('button', {
        name: 'Confirm move and audience change',
      }),
    );
    await screen.findByText('Folder moved');
    expect(moved).toEqual([
      {
        parentId: operations.id,
        expectedFolderRevision: finance.revision,
        audienceReview: { token: 'c'.repeat(64), acknowledge: true },
      },
    ]);
  });

  it('labels bounded folder ancestry and maps the top level to null', async () => {
    const change = vi.fn();
    render(
      <WorkflowFolderPicker
        folders={[finance, invoices]}
        value={invoices.id}
        onChange={change}
      />,
    );
    const picker = screen.getByRole('combobox', { name: 'Folder' });
    expect(picker).toHaveTextContent('Finance / Invoices');
    const event = userEvent.setup();
    picker.focus();
    await event.keyboard('{ArrowDown}');
    await event.click(
      await screen.findByRole('option', { name: 'Unfiled / top level' }),
    );
    expect(change).toHaveBeenCalledWith(null);
  });
});
