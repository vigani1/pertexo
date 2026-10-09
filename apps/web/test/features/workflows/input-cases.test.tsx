import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  accessibleWorkspaceSchema,
  workflowSummarySchema,
} from '@pertexo/contracts';
import { InputCasesPanel } from '@/features/workflows/input-cases.public';
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
  versionChecksum: `wf:v2:sha256:${'a'.repeat(64)}`,
  name: 'Synthetic customer',
  revision: 1,
  representationTag: `"wic1.${caseId.replaceAll('-', '')}.1"`,
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
};

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
    <InputCasesPanel
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
