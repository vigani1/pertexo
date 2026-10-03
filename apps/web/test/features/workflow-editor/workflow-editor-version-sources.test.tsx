import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { workflowVersionResponseSchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { workflowVersionSourcesQueryOptions } from '@/features/workflow-editor/workflow-version-sources.queries';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  api,
  editorHandlers,
  editorPath,
  findCanvas,
  userId,
  workspaceId,
} from '../../support/workflow-editor-fixtures';
import {
  nativeCallGraph,
  workflowCallPin,
} from '../../support/workflow-call-fixtures';
import {
  callableVersionSource,
  versionSourceWorkflow,
} from '../../support/workflow-version-source-fixtures';

const listPath = `${api}/workspaces/${workspaceId}/workflows`;
const versionsPath = `${listPath}/${workflowCallPin.workflowId}/versions`;

async function chooseSource(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole('button', { name: 'Browse version source' }),
  );
  const dialog = screen.getByRole('dialog', { name: 'Browse version source' });
  await user.click(await within(dialog).findByLabelText('Workflow source'));
  await user.click(
    await screen.findByRole('option', {
      name: 'Reusable child source (active)',
    }),
  );
  return dialog;
}

describe('Call version source browser', { timeout: 30_000 }, () => {
  it('retains the selected last-good source and unchanged pin after a failed background refetch', async () => {
    let fail = false;
    const save = vi.fn();
    mockServer.use(
      ...editorHandlers(save, { graph: nativeCallGraph() }),
      http.get(listPath, () =>
        HttpResponse.json({
          items: [versionSourceWorkflow(workspaceId)],
          nextCursor: null,
        }),
      ),
      http.get(versionsPath, () =>
        fail
          ? HttpResponse.json({}, { status: 500 })
          : HttpResponse.json({
              items: [callableVersionSource],
              nextCursor: null,
            }),
      ),
    );
    const { apiClient, queryClient } = renderApp(editorPath);
    const user = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Call child'));
    const dialog = await chooseSource(user);
    await user.click(
      await within(dialog).findByLabelText('Published version source'),
    );
    await user.click(
      await screen.findByRole('option', {
        name: `v2 — ${callableVersionSource.id}`,
      }),
    );
    expect(
      within(dialog).getByRole('region', { name: 'Inspected version source' }),
    ).toBeVisible();
    fail = true;
    const options = workflowVersionSourcesQueryOptions(
      { apiClient, userId, workspaceId },
      workflowCallPin.workflowId,
    );
    await queryClient.refetchQueries({ queryKey: options.queryKey });
    await waitFor(() => {
      expect(queryClient.getQueryState(options.queryKey)?.status).toBe('error');
    });
    expect(
      within(dialog).getByRole('region', { name: 'Inspected version source' }),
    ).toBeVisible();
    expect(
      within(dialog).getByLabelText('Published version source'),
    ).toHaveTextContent('v2');
    expect(within(dialog).getByText('Source may be stale')).toBeVisible();
    expect(
      within(dialog).getByRole('button', { name: 'Retry version sources' }),
    ).toBeEnabled();
    expect(
      within(dialog).getByLabelText('Callable result declaration'),
    ).toHaveTextContent('answer');
    await user.click(
      within(dialog).getByRole('button', { name: 'Close source browser' }),
    );
    expect(screen.getByLabelText('Pinned version ID')).toHaveValue(
      workflowCallPin.versionId,
    );
    expect(screen.getByLabelText('Callable contract identity')).toHaveValue(
      workflowCallPin.callableContractIdentity,
    );
    expect(save).not.toHaveBeenCalled();
  });
  it('uses a contract-valid source fixture', () => {
    expect(
      workflowVersionResponseSchema.safeParse(callableVersionSource),
    ).toMatchObject({ success: true });
  });
  it('reads lazily, chooses no default version and copies only source values without saving a pin', async () => {
    const save = vi.fn();
    const reads: string[] = [];
    const other = {
      ...versionSourceWorkflow(workspaceId),
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Other source',
    };
    mockServer.use(
      ...editorHandlers(save, { graph: nativeCallGraph() }),
      http.get(listPath, () =>
        HttpResponse.json({
          items: [versionSourceWorkflow(workspaceId), other],
          nextCursor: null,
        }),
      ),
      http.get(`${listPath}/:sourceId/versions`, ({ params }) => {
        reads.push(String(params.sourceId));
        return HttpResponse.json({
          items: [callableVersionSource],
          nextCursor: null,
        });
      }),
    );
    renderApp(editorPath, { strict: true });
    const user = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Call child'));
    expect(reads).toEqual([]);
    const dialog = await chooseSource(user);
    const versionChoice = await within(dialog).findByLabelText(
      'Published version source',
    );
    expect(versionChoice).toHaveTextContent('Choose a version to inspect');
    expect(
      within(dialog).queryByRole('region', {
        name: 'Inspected version source',
      }),
    ).not.toBeInTheDocument();
    await user.click(versionChoice);
    await user.click(
      await screen.findByRole('option', {
        name: `v2 — ${callableVersionSource.id}`,
      }),
    );
    expect(
      within(dialog).getByText('Source only — eligibility unverified'),
    ).toBeVisible();
    expect(
      within(dialog).getByLabelText('Callable input declaration'),
    ).toHaveTextContent('name');
    expect(
      within(dialog).getByLabelText('Callable result declaration'),
    ).toHaveTextContent('answer');
    for (const [label, value] of [
      ['Copy source workflow ID', callableVersionSource.workflowId],
      ['Copy source version ID', callableVersionSource.id],
      ['Copy source version checksum', callableVersionSource.checksum],
    ] as const) {
      await user.click(within(dialog).getByRole('button', { name: label }));
      expect(await navigator.clipboard.readText()).toBe(value);
    }
    // StrictMode may abort and restart the selected read; it must never fan out.
    expect(new Set(reads)).toEqual(new Set([workflowCallPin.workflowId]));
    await user.click(
      within(dialog).getByRole('button', { name: 'Close source browser' }),
    );
    expect(screen.getByLabelText('Pinned version ID')).toHaveValue(
      workflowCallPin.versionId,
    );
    expect(screen.getByLabelText('Callable contract identity')).toHaveValue(
      workflowCallPin.callableContractIdentity,
    );
    expect(save).not.toHaveBeenCalled();
  });
  it('allows read-only source inspection while preserving unsupported configuration and mappings', async () => {
    const save = vi.fn();
    const config = { ...workflowCallPin, futureOption: { keep: true } };
    mockServer.use(
      ...editorHandlers(save, {
        graph: nativeCallGraph(config),
        capabilities: ['workspace:read', 'workflow:read'],
      }),
      http.get(listPath, () =>
        HttpResponse.json({
          items: [versionSourceWorkflow(workspaceId)],
          nextCursor: null,
        }),
      ),
      http.get(versionsPath, () =>
        HttpResponse.json({ items: [callableVersionSource], nextCursor: null }),
      ),
    );
    renderApp(editorPath, { strict: true });
    const user = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Call child'));
    expect(
      JSON.parse(
        screen.getByLabelText<HTMLTextAreaElement>('Setup as JSON').value,
      ),
    ).toEqual(config);
    expect(screen.getByLabelText('Setup as JSON')).toBeDisabled();
    const dialog = await chooseSource(user);
    expect(
      await within(dialog).findByLabelText('Published version source'),
    ).toBeEnabled();
    await user.click(
      within(dialog).getByRole('button', { name: 'Close source browser' }),
    );
    expect(
      JSON.parse(
        screen.getByLabelText<HTMLTextAreaElement>('Setup as JSON').value,
      ),
    ).toEqual(config);
    expect(save).not.toHaveBeenCalled();
  });
  it('reports failed version discovery as incomplete, not absent or current', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, { graph: nativeCallGraph() }),
      http.get(listPath, () =>
        HttpResponse.json({
          items: [versionSourceWorkflow(workspaceId)],
          nextCursor: null,
        }),
      ),
      http.get(versionsPath, () => HttpResponse.json({}, { status: 500 })),
    );
    renderApp(editorPath);
    const user = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Call child'));
    const dialog = await chooseSource(user);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Version discovery is incomplete',
    );
    expect(
      within(dialog).queryByText(/No published version sources/u),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText('Published version source'),
    ).not.toBeInTheDocument();
  });
  it('retains loaded workflows and exposes a next-page failure without an absence claim', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, { graph: nativeCallGraph() }),
      http.get(listPath, ({ request }) =>
        new URL(request.url).searchParams.has('after')
          ? HttpResponse.json({}, { status: 500 })
          : HttpResponse.json({
              items: [versionSourceWorkflow(workspaceId)],
              nextCursor: 'next-page',
            }),
      ),
    );
    renderApp(editorPath);
    const user = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Call child'));
    await user.click(
      screen.getByRole('button', { name: 'Browse version source' }),
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Browse version source',
    });
    await user.click(
      await within(dialog).findByRole('button', {
        name: 'Load more workflow sources',
      }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The ones above are unchanged',
    );
    expect(
      within(dialog).getByText(
        'Only loaded workflow pages are shown; discovery is incomplete.',
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Workflow source')).toBeEnabled(),
    );
    expect(
      within(dialog).queryByText(
        'No workflows were returned for this workspace.',
      ),
    ).not.toBeInTheDocument();
  });
});
