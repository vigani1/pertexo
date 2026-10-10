import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  accessibleWorkspaceSchema,
  workflowSummarySchema,
} from '@pertexo/contracts';
import {
  InputCasesPanel,
  useInputCases,
} from '@/features/workflows/input-cases.public';
import { InputCasesAction } from '@/features/workflows/components/input-cases/action';
import { ApiError } from '@/lib/api/error';
import { workflowKeys } from '@/features/workflows/data/workflows.queries';
import { workflowTemplateOriginKey } from '@/features/workflows/data/origin/queries';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../support/mock-server';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import {
  api,
  discoveryHandlers,
  workspaceWith,
  summary,
  userId,
  workspaceId,
  workflowId,
  versionId,
  problem,
} from './list/fixtures';

const caseId = '34343434-3434-4343-8343-343434343434';
const path = `${api}/workflows/${workflowId}/input-cases`;
const metadata = {
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

function CaseBrowser(
  props: Omit<React.ComponentProps<typeof InputCasesPanel>, 'cases'> &
    Readonly<{ apiClient: ReturnType<typeof createApiClient>; userId: string }>,
) {
  const cases = useInputCases(
    props.apiClient,
    props.userId,
    props.workspace.id,
    props.workflow.id,
    props.workspace.capabilities.includes('workflow:update'),
  );
  return <InputCasesPanel {...props} cases={cases} />;
}

function open(canWrite = true) {
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
      workspace={accessibleWorkspaceSchema.parse(
        workspaceWith(canWrite ? ['workflow:update'] : ['run:start']),
      )}
      workflow={workflowSummarySchema.parse(
        summary(workflowId, 'Case workflow', { publishedVersionId: versionId }),
      )}
      onLoad={onLoad}
    />,
  );
  return { ...result, onLoad, event: userEvent.setup() };
}

describe('shared workflow input cases', () => {
  it('refreshes saved edits while another case browser for the same workflow is closed', async () => {
    let current = metadata;
    let listReads = 0;
    let saving = 0;
    let release!: () => void;
    mockServer.use(
      ...discoveryHandlers(['workflow:update']),
      http.get(path, () => {
        listReads += 1;
        return HttpResponse.json({ items: [current] });
      }),
      http.get(`${path}/${caseId}`, () =>
        HttpResponse.json(
          { case: { ...current, input: { customer: 'synthetic' } } },
          { headers: { ETag: current.representationTag } },
        ),
      ),
      http.put(`${path}/${caseId}`, async ({ request }) => {
        const body = (await request.json()) as { name: string };
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        saving += 1;
        await held;
        current = {
          ...current,
          name: body.name,
          revision: current.revision + 1,
        };
        return HttpResponse.json({
          caseId,
          revision: current.revision,
          replayed: false,
        });
      }),
    );
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    });
    const workspace = accessibleWorkspaceSchema.parse(
      workspaceWith(['workflow:update']),
    );
    const workflow = workflowSummarySchema.parse(
      summary(workflowId, 'Case workflow', { publishedVersionId: versionId }),
    );
    function ClosedCaseBrowser() {
      const [revision, setRevision] = useState(0);
      useInputCases(apiClient, userId, workspaceId, workflowId, true, false);
      return (
        <button
          onClick={() => {
            setRevision(revision + 1);
          }}
        >
          Refresh closed browser {revision}
        </button>
      );
    }
    renderInRouter(
      <>
        <CaseBrowser
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          workflow={workflow}
          onLoad={vi.fn()}
        />
        <ClosedCaseBrowser />
      </>,
    );
    const event = userEvent.setup();
    for (const name of ['Edited proof', 'Final original proof']) {
      await event.click(await screen.findByRole('button', { name: /^Edit /u }));
      const field = await screen.findByLabelText('Case name');
      await event.clear(field);
      await event.type(field, name);
      await event.click(
        screen.getByRole('button', { name: 'Save input case' }),
      );
      await waitFor(() => {
        expect(saving).toBe(current.revision);
      });
      await event.click(
        screen.getByRole('button', { name: /Refresh closed browser/u }),
      );
      act(() => {
        release();
      });
      await screen.findByRole('button', { name: `Load ${name}` });
      expect(screen.queryByText(/Couldn’t refresh/u)).not.toBeInTheDocument();
    }
    expect(listReads).toBe(3);
  });

  it('reads only while open and shares its pending-read dismissal guard with the panel', async () => {
    let listReads = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let readStarted = false;
    mockServer.use(
      ...discoveryHandlers(['workflow:update']),
      http.get(path, () => {
        listReads += 1;
        return HttpResponse.json({ items: [metadata] });
      }),
      http.get(`${path}/${caseId}`, async () => {
        readStarted = true;
        await held;
        return HttpResponse.json(
          {
            case: { ...metadata, input: { customer: 'synthetic' } },
          },
          { headers: { ETag: metadata.representationTag } },
        );
      }),
    );
    renderInRouter(
      <InputCasesAction
        apiClient={createApiClient({
          fetch: testFetch,
          readCsrfToken: () =>
            'csrf-token-for-component-tests-12345678901234567890',
        })}
        userId={userId}
        workspace={accessibleWorkspaceSchema.parse(
          workspaceWith(['workflow:update']),
        )}
        workflow={workflowSummarySchema.parse(
          summary(workflowId, 'Case workflow', {
            publishedVersionId: versionId,
          }),
        )}
      />,
    );
    const event = userEvent.setup();
    const trigger = await screen.findByRole('button', {
      name: 'Input cases',
    });
    expect(listReads).toBe(0);
    await event.click(trigger);
    const dialog = await screen.findByRole('dialog', {
      name: 'Input cases',
    });
    await event.click(
      await within(dialog).findByRole('button', {
        name: 'Load Synthetic customer',
      }),
    );
    await waitFor(() => {
      expect(readStarted).toBe(true);
    });
    expect(
      within(dialog).getByRole('button', { name: 'Close input cases' }),
    ).toBeDisabled();
    await event.keyboard('{Escape}');
    expect(dialog).toBeVisible();
    release();
    await waitFor(() => {
      expect(
        within(dialog).getByLabelText('Loaded input: Synthetic customer'),
      ).toHaveValue(JSON.stringify({ customer: 'synthetic' }, null, 2));
    });
    await event.click(
      within(dialog).getByRole('button', { name: 'Close input cases' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(listReads).toBe(1);
    await event.click(trigger);
    await waitFor(() => {
      expect(listReads).toBe(2);
    });
    expect(
      screen.queryByLabelText('Loaded input: Synthetic customer'),
    ).not.toBeInTheDocument();
  });

  it('reopens with a fresh case owner after a denied payload read', async () => {
    let payloadReads = 0;
    mockServer.use(
      ...discoveryHandlers(['workflow:update']),
      http.get(path, () => HttpResponse.json({ items: [metadata] })),
      http.get(`${path}/${caseId}`, () => {
        payloadReads += 1;
        return payloadReads === 1
          ? problem(403, 'workflow.input_case_access_denied')
          : HttpResponse.json(
              {
                case: { ...metadata, input: { customer: 'authorized again' } },
              },
              { headers: { ETag: metadata.representationTag } },
            );
      }),
    );
    renderInRouter(
      <InputCasesAction
        apiClient={createApiClient({
          fetch: testFetch,
          readCsrfToken: () =>
            'csrf-token-for-component-tests-12345678901234567890',
        })}
        userId={userId}
        workspace={accessibleWorkspaceSchema.parse(
          workspaceWith(['workflow:update']),
        )}
        workflow={workflowSummarySchema.parse(
          summary(workflowId, 'Case workflow', {
            publishedVersionId: versionId,
          }),
        )}
      />,
    );
    const event = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Input cases' });
    await event.click(trigger);
    await event.click(
      await screen.findByRole('button', { name: 'Load Synthetic customer' }),
    );
    expect(
      await screen.findByText('Access to input cases is no longer available.'),
    ).toBeVisible();
    await event.click(
      screen.getByRole('button', { name: 'Close input cases' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await event.click(trigger);
    await event.click(
      await screen.findByRole('button', { name: 'Load Synthetic customer' }),
    );
    expect(
      await screen.findByLabelText('Loaded input: Synthetic customer'),
    ).toHaveValue(JSON.stringify({ customer: 'authorized again' }, null, 2));
    expect(payloadReads).toBe(2);
  });

  it('ignores optional and unrelated not-found reads but retires on its own workflow denial', async () => {
    const { queryClient } = open(false);
    const load = await screen.findByRole('button', {
      name: 'Load Synthetic customer',
    });
    async function rejectRead(queryKey: readonly unknown[], status: number) {
      await act(async () => {
        await queryClient
          .query({
            queryKey,
            queryFn: () =>
              Promise.reject(
                new ApiError({
                  kind: 'problem',
                  status,
                  message: 'Read unavailable.',
                }),
              ),
            retry: false,
          })
          .catch(() => undefined);
      });
    }
    await rejectRead(
      workflowTemplateOriginKey(userId, workspaceId, workflowId),
      404,
    );
    await rejectRead(
      workflowKeys.detail(userId, workspaceId, 'other-workflow'),
      404,
    );
    expect(load).toBeEnabled();
    expect(
      screen.queryByText('Access to input cases is no longer available.'),
    ).not.toBeInTheDocument();
    await rejectRead(workflowKeys.detail(userId, workspaceId, workflowId), 403);
    expect(
      await screen.findByText('Access to input cases is no longer available.'),
    ).toBeVisible();
    expect(load).not.toBeInTheDocument();
  });

  it('does not load a held payload after its component owner is disposed', async () => {
    const { event, onLoad, unmount } = open(false);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    mockServer.use(
      http.get(`${path}/${caseId}`, async () => {
        started = true;
        await held;
        return HttpResponse.json({
          case: { ...metadata, input: { private: 'old owner payload' } },
        });
      }),
    );
    await event.click(
      await screen.findByRole('button', { name: 'Load Synthetic customer' }),
    );
    await waitFor(() => {
      expect(started).toBe(true);
    });
    unmount();
    release();
    await held;
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('hides cached metadata and payload controls after an actual case-read denial', async () => {
    const { event, onLoad } = open(false);
    mockServer.use(
      http.get(`${path}/${caseId}`, () => problem(403, 'auth.forbidden')),
    );
    await event.click(
      await screen.findByRole('button', { name: 'Load Synthetic customer' }),
    );
    await screen.findByText('Access to input cases is no longer available.');
    expect(
      screen.queryByRole('button', { name: 'Load Synthetic customer' }),
    ).not.toBeInTheDocument();
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('lets operators load a detached input without CRUD or execution', async () => {
    const { event, onLoad } = open(false);
    await event.click(
      await screen.findByRole('button', { name: 'Load Synthetic customer' }),
    );
    await waitFor(() => {
      expect(onLoad).toHaveBeenCalledOnce();
    });
    expect(onLoad).toHaveBeenCalledWith({
      name: metadata.name,
      workflowVersionId: versionId,
      input: { customer: 'synthetic' },
    });
    expect(
      screen.queryByRole('button', { name: 'New input case' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit Synthetic customer' }),
    ).not.toBeInTheDocument();
  });

  it('admits only one same-tick payload read and unlocks after failure', async () => {
    const { event, onLoad } = open(false);
    let reads = 0;
    mockServer.use(
      http.get(`${path}/${caseId}`, () => {
        reads += 1;
        return reads === 1
          ? HttpResponse.error()
          : HttpResponse.json(
              {
                case: { ...metadata, input: { nested: { value: 'original' } } },
              },
              { headers: { ETag: metadata.representationTag } },
            );
      }),
    );
    const load = await screen.findByRole('button', {
      name: 'Load Synthetic customer',
    });
    act(() => {
      load.click();
      load.click();
    });
    await screen.findByRole('alert');
    expect(reads).toBe(1);
    await waitFor(() => expect(load).toBeEnabled());
    await event.click(load);
    await waitFor(() => {
      expect(onLoad).toHaveBeenCalledOnce();
    });
    expect(reads).toBe(2);
  });

  it('admits only one same-tick save while preserving the exact recovery command', async () => {
    const captures: unknown[] = [];
    mockServer.use(
      http.put(`${path}/${caseId}`, async ({ request }) => {
        captures.push(await request.json());
        return HttpResponse.error();
      }),
    );
    const { event } = open();
    await event.click(
      await screen.findByRole('button', { name: 'Edit Synthetic customer' }),
    );
    const save = await screen.findByRole('button', { name: 'Save input case' });
    act(() => {
      save.click();
      save.click();
    });
    await screen.findByRole('button', { name: 'Retry exact case change' });
    expect(captures).toEqual([
      { name: metadata.name, input: { customer: 'synthetic' } },
    ]);
    expect(screen.getByLabelText('Case name')).toBeDisabled();
  });

  it('keeps case edits on a typed conflict and requires explicit current-read review', async () => {
    const writes: { body: unknown; tag: string | null; key: string | null }[] =
      [];
    mockServer.use(
      http.put(`${path}/${caseId}`, async ({ request }) => {
        writes.push({
          body: await request.json(),
          tag: request.headers.get('if-match'),
          key: request.headers.get('idempotency-key'),
        });
        return problem(412, 'workflow.input_case_revision_conflict');
      }),
    );
    const { event } = open();
    await event.click(
      await screen.findByRole('button', { name: 'Edit Synthetic customer' }),
    );
    const input = await screen.findByLabelText('Case input (JSON)');
    await event.clear(input);
    await event.type(input, '{{"customer":"changed"}', { skipClick: true });
    await event.click(screen.getByRole('button', { name: 'Save input case' }));
    await screen.findByText(/This case changed elsewhere/u);
    expect(input).toHaveValue('{"customer":"changed"}');
    expect(writes[0]?.body).toEqual({
      name: metadata.name,
      input: { customer: 'changed' },
    });
    expect(writes[0]?.tag).toBe(metadata.representationTag);
    expect(
      screen.getByRole('button', { name: 'Save input case' }),
    ).toBeDisabled();
    await event.click(
      screen.getByRole('button', { name: 'Read current case; keep my edits' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save input case' }),
      ).toBeEnabled(),
    );
    expect(input).toHaveValue('{"customer":"changed"}');
  });

  it('retries a lost update with the same body, opaque tag and key', async () => {
    const writes: { body: unknown; tag: string | null; key: string | null }[] =
      [];
    mockServer.use(
      http.put(`${path}/${caseId}`, async ({ request }) => {
        writes.push({
          body: await request.json(),
          tag: request.headers.get('if-match'),
          key: request.headers.get('idempotency-key'),
        });
        return writes.length === 1
          ? HttpResponse.error()
          : HttpResponse.json({ caseId, revision: 2, replayed: true });
      }),
    );
    const { event } = open();
    await event.click(
      await screen.findByRole('button', { name: 'Edit Synthetic customer' }),
    );
    await screen.findByLabelText('Case name');
    await event.click(screen.getByRole('button', { name: 'Save input case' }));
    await screen.findByRole('button', { name: 'Retry exact case change' });
    expect(screen.getByLabelText('Case input (JSON)')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Cancel case edit' }),
    ).toBeDisabled();
    await event.click(
      screen.getByRole('button', { name: 'Retry exact case change' }),
    );
    await waitFor(() => {
      expect(writes).toHaveLength(2);
    });
    expect(writes[1]).toEqual(writes[0]);
  });
});
