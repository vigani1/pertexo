import { workflowTemplateOriginKey } from '@/features/workflows/data/origin/queries';

import { workflowKeys } from '@/features/workflows/data/workflows.queries';

import { useInputCases } from '@/features/workflows/input-cases.public';

import { createApiClient } from '@/lib/api/client';

import { ApiError } from '@/lib/api/error';

import {
  accessibleWorkspaceSchema,
  workflowSummarySchema,
} from '@pertexo/contracts';

import { act, screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { http, HttpResponse } from 'msw';

import { useState } from 'react';

import { describe, expect, it, vi } from 'vitest';

import { mockServer } from '../../support/mock-server';

import { testFetch } from '../../support/render-app';

import { renderInRouter } from '../../support/render-in-router';

import { CaseBrowser, InputCasesActionHarness } from './input-cases/browsers';
import { caseId, metadata, open, path } from './input-cases/fixture';

import {
  discoveryHandlers,
  problem,
  summary,
  userId,
  versionId,
  workflowId,
  workspaceId,
  workspaceWith,
} from './list/fixtures';

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
      useInputCases({
        api: apiClient,
        userId,
        workspaceId,
        workflowId,
        canWrite: true,
        enabled: false,
      });
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
          onLoad={vi.fn()}
          scope={{ workspace, workflow: workflow }}
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
      <InputCasesActionHarness
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
      <InputCasesActionHarness
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
});
