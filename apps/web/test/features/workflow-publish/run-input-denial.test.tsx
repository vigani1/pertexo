import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import {
  accessibleWorkspaceSchema,
  workflowSummarySchema,
} from '@pertexo/contracts';
import { RunInputDialog } from '@/features/workflow-publish/components/run-submission/run-input-dialog';
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
} from '../workflows/list/fixtures';

const caseId = '34343434-3434-4343-8343-343434343434';
const path = `${api}/workflows/${workflowId}/input-cases`;
const metadata = {
  id: caseId,
  workspaceId,
  workflowId,
  workflowVersionId: versionId,
  versionChecksum: `wf:v2:sha256:${'a'.repeat(64)}`,
  name: 'Denial fixture',
  revision: 1,
  representationTag: `"wic1.${caseId.replaceAll('-', '')}.1"`,
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
};

function open() {
  mockServer.use(
    ...discoveryHandlers(['workflow:update', 'run:start']),
    http.get(path, () => HttpResponse.json({ items: [metadata] })),
    http.get(`${path}/${caseId}`, () =>
      HttpResponse.json(
        {
          case: { ...metadata, input: { private: 'denied synthetic payload' } },
        },
        { headers: { ETag: metadata.representationTag } },
      ),
    ),
  );
  const apiClient = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  const start = vi.fn().mockResolvedValue(false);
  function Harness() {
    const [opened, setOpened] = useState(true);
    return (
      <RunInputDialog
        open={opened}
        pending={false}
        error={undefined}
        retryAvailable={false}
        onOpenChange={setOpened}
        onStartNew={start}
        onRetry={vi.fn().mockResolvedValue(false)}
        caseScope={{
          apiClient,
          userId,
          workspace: accessibleWorkspaceSchema.parse(
            workspaceWith(['workflow:update', 'run:start']),
          ),
          workflow: workflowSummarySchema.parse(
            summary(workflowId, 'Denial workflow', {
              publishedVersionId: versionId,
            }),
          ),
        }}
      />
    );
  }
  renderInRouter(<Harness />);
  return { event: userEvent.setup(), start };
}

async function expectHiddenAndDismissible(
  event: ReturnType<typeof userEvent.setup>,
) {
  await screen.findByText('Access to input cases is no longer available.');
  expect(screen.queryByLabelText('Run input (JSON)')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Case input (JSON)')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Retry exact case change' }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Start published version' }),
  ).toBeDisabled();
  const cancel = screen.getByRole('button', { name: 'Cancel' });
  await waitFor(() => expect(cancel).toBeEnabled());
  await event.click(cancel);
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Run with input' }),
    ).not.toBeInTheDocument(),
  );
}

it.each([403, 404])(
  'retires a denied %i case read without trapping the parent dialog',
  async (status) => {
    const { event, start } = open();
    await event.click(
      await screen.findByRole('button', { name: 'Load Denial fixture' }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Run input (JSON)')).toHaveValue(
        JSON.stringify({ private: 'denied synthetic payload' }, null, 2),
      ),
    );
    mockServer.use(
      http.get(`${path}/${caseId}`, () =>
        problem(
          status,
          status === 403 ? 'auth.forbidden' : 'resource.not_found',
        ),
      ),
    );
    await event.click(
      screen.getByRole('button', { name: 'Edit Denial fixture' }),
    );
    await expectHiddenAndDismissible(event);
    expect(start).not.toHaveBeenCalled();
  },
);

it.each([403, 404])(
  'retires a denied %i dispatched mutation and unlocks parent dismissal',
  async (status) => {
    const { event, start } = open();
    await event.click(
      await screen.findByRole('button', { name: 'Load Denial fixture' }),
    );
    await event.click(
      screen.getByRole('button', { name: 'Edit Denial fixture' }),
    );
    await screen.findByLabelText('Case input (JSON)');
    mockServer.use(
      http.put(`${path}/${caseId}`, () =>
        problem(
          status,
          status === 403 ? 'auth.forbidden' : 'resource.not_found',
        ),
      ),
    );
    await event.click(screen.getByRole('button', { name: 'Save input case' }));
    await expectHiddenAndDismissible(event);
    expect(start).not.toHaveBeenCalled();
  },
);

it('retires retained uncertain intent when mutation authority disappears before retry', async () => {
  const { event, start } = open();
  const writes = vi.fn(() => HttpResponse.error());
  mockServer.use(http.put(`${path}/${caseId}`, writes));
  await event.click(
    await screen.findByRole('button', { name: 'Load Denial fixture' }),
  );
  await event.click(
    screen.getByRole('button', { name: 'Edit Denial fixture' }),
  );
  await screen.findByLabelText('Case input (JSON)');
  await event.click(screen.getByRole('button', { name: 'Save input case' }));
  await screen.findByRole('button', { name: 'Retry exact case change' });
  mockServer.use(
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({
        items: [workspaceWith(['run:start'])],
        nextCursor: null,
      }),
    ),
  );
  await event.click(
    screen.getByRole('button', { name: 'Retry exact case change' }),
  );
  await expectHiddenAndDismissible(event);
  expect(writes).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
});
