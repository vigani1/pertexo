import { HttpResponse, http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { accessibleWorkspaceSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { workflowSummarySchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { WorkflowDuplicateDialog } from '@/features/workflows/duplicate.public';
import { createApiClient } from '@/lib/api/client';
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
  workspaceWith,
  problem,
  user,
} from './workflow-list.fixtures';

function open() {
  mockServer.use(
    ...discoveryHandlers(),
    http.get(`${api}/workflows/${workflowId}/draft`, () =>
      HttpResponse.json(draftBody(workflowId), { headers: { etag } }),
    ),
  );
  const onCreated = vi.fn();
  renderInRouter(
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
      source={{ kind: 'draft' }}
      onCreated={onCreated}
      onClose={vi.fn()}
    />,
  );
  return { onCreated, event: userEvent.setup() };
}

const identityUrl = 'http://pertexo.test/v1/users/me';
const workspaceUrl = 'http://pertexo.test/v1/workspaces';
const created = () =>
  HttpResponse.json({ workflowId: versionId }, { status: 201 });
const transient = (status: number) => problem(status, 'platform.unavailable');
const outages = [
  {
    label: 'identity network failure',
    url: identityUrl,
    response: () => HttpResponse.error(),
  },
  { label: 'workspace 429', url: workspaceUrl, response: () => transient(429) },
  { label: 'workspace 503', url: workspaceUrl, response: () => transient(503) },
];

function captureCopies(response: (count: number) => Response) {
  const requests: { body: unknown; key: string | null; tag: string | null }[] =
    [];
  mockServer.use(
    http.post(
      `${api}/workflows/${workflowId}/duplicate`,
      async ({ request }) => {
        requests.push({
          body: await request.json(),
          key: request.headers.get('Idempotency-Key'),
          tag: request.headers.get('If-Match'),
        });
        return response(requests.length);
      },
    ),
  );
  return requests;
}

async function expectRecovery() {
  expect(
    await screen.findByRole('button', { name: 'Retry exact copy' }),
  ).toBeEnabled();
  expect(screen.getByLabelText('Copy name')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(screen.queryByText(/Nothing was changed/u)).not.toBeInTheDocument();
}

describe('Duplicate command lifecycle recovery', () => {
  it.each(outages)(
    'retains an accepted copy through postflight $label',
    async ({ url, response }) => {
      const { event, onCreated } = open();
      const requests = captureCopies(() => {
        mockServer.use(http.get(url, response));
        return created();
      });
      await screen.findByText(/Source: saved draft revision 1/u);
      await event.click(
        screen.getByRole('button', { name: 'Duplicate workflow' }),
      );
      await expectRecovery();
      expect(requests).toHaveLength(1);
      expect(onCreated).not.toHaveBeenCalled();
      mockServer.use(...discoveryHandlers());
      // The replay succeeds without introducing another authority outage.
      mockServer.use(
        http.post(
          `${api}/workflows/${workflowId}/duplicate`,
          async ({ request }) => {
            requests.push({
              body: await request.json(),
              key: request.headers.get('Idempotency-Key'),
              tag: request.headers.get('If-Match'),
            });
            return created();
          },
        ),
      );
      await event.click(
        screen.getByRole('button', { name: 'Retry exact copy' }),
      );
      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
      });
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
    },
  );

  it.each(outages)(
    'keeps a lost POST across retry preflight $label',
    async ({ url, response }) => {
      const { event, onCreated } = open();
      const requests = captureCopies((count) =>
        count === 1 ? HttpResponse.error() : created(),
      );
      await screen.findByText(/Source: saved draft revision 1/u);
      await event.click(
        screen.getByRole('button', { name: 'Duplicate workflow' }),
      );
      await expectRecovery();
      mockServer.use(http.get(url, response));
      await event.click(
        screen.getByRole('button', { name: 'Retry exact copy' }),
      );
      await expectRecovery();
      expect(requests).toHaveLength(1);
      expect(onCreated).not.toHaveBeenCalled();
      mockServer.use(...discoveryHandlers());
      await event.click(
        screen.getByRole('button', { name: 'Retry exact copy' }),
      );
      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
      });
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
    },
  );

  it.each([429, 503])(
    'keeps a lost POST across recovery POST %s',
    async (status) => {
      const { event, onCreated } = open();
      const requests = captureCopies((count) =>
        count === 1
          ? HttpResponse.error()
          : count === 2
            ? transient(status)
            : created(),
      );
      await screen.findByText(/Source: saved draft revision 1/u);
      await event.click(
        screen.getByRole('button', { name: 'Duplicate workflow' }),
      );
      await expectRecovery();
      await event.click(
        screen.getByRole('button', { name: 'Retry exact copy' }),
      );
      await expectRecovery();
      expect(onCreated).not.toHaveBeenCalled();
      await event.click(
        screen.getByRole('button', { name: 'Retry exact copy' }),
      );
      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
      });
      expect(requests).toHaveLength(3);
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[2]).toEqual(requests[0]);
    },
  );

  it.each([
    { label: '401', response: () => problem(401, 'auth.unauthenticated') },
    {
      label: 'changed identity',
      response: () => HttpResponse.json({ ...user, id: versionId }),
    },
  ])(
    'retires an accepted command on confirmed postflight $label',
    async ({ response }) => {
      const { event, onCreated } = open();
      const requests = captureCopies(() => {
        mockServer.use(http.get(identityUrl, response));
        return created();
      });
      await screen.findByText(/Source: saved draft revision 1/u);
      await event.click(
        screen.getByRole('button', { name: 'Duplicate workflow' }),
      );
      await screen.findByText(/Access changed/u);
      expect(
        screen.queryByRole('button', { name: 'Retry exact copy' }),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText('Copy name')).toHaveValue('');
      expect(requests).toHaveLength(1);
      expect(onCreated).not.toHaveBeenCalled();
    },
  );

  it('does not offer command replay when initial authority verification failed before any POST', async () => {
    const { event, onCreated } = open();
    const requests = captureCopies(created);
    await screen.findByText(/Source: saved draft revision 1/u);
    mockServer.use(http.get(identityUrl, () => HttpResponse.error()));
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Duplicate workflow' }),
      ).toBeEnabled(),
    );
    expect(
      screen.queryByRole('button', { name: 'Retry exact copy' }),
    ).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
    expect(onCreated).not.toHaveBeenCalled();
    mockServer.use(...discoveryHandlers());
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
    });
    expect(requests).toHaveLength(1);
  });
});
