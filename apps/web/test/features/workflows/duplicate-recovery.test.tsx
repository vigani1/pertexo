import { HttpResponse, http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  accessibleWorkspaceSchema,
  workflowSummarySchema,
} from '@pertexo/contracts';
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
} from './list/fixtures';

function open() {
  mockServer.use(
    ...discoveryHandlers(),
    http.get(`${api}/workflows/${workflowId}/draft`, () =>
      HttpResponse.json(draftBody(workflowId), { headers: { etag } }),
    ),
  );
  const onCreated = vi.fn();
  const view = renderInRouter(
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
  return { ...view, onCreated, event: userEvent.setup() };
}

const identityUrl = 'http://pertexo.test/v1/users/me';
const workspaceUrl = 'http://pertexo.test/v1/workspaces';
const created = () =>
  HttpResponse.json({ workflowId: versionId }, { status: 201 });
const transient = (status: number) => problem(status, 'platform.unavailable');
const nextTag = `"draft-v1.${'b'.repeat(43)}"`;
const staleResponse = () =>
  HttpResponse.json(
    {
      type: 'urn:pertexo:problem:workflow.revision_conflict',
      title: 'Changed',
      status: 412,
      code: 'workflow.revision_conflict',
      requestId: 'fixture-stale',
      currentRevision: 2,
      currentEtag: nextTag,
    },
    { status: 412, headers: { 'content-type': 'application/problem+json' } },
  );
const outages = [
  {
    label: 'identity network failure',
    url: identityUrl,
    response: () => HttpResponse.error(),
  },
  { label: 'workspace 429', url: workspaceUrl, response: () => transient(429) },
  { label: 'workspace 503', url: workspaceUrl, response: () => transient(503) },
  { label: 'workspace read 412', url: workspaceUrl, response: staleResponse },
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
  it('does not read authority after unmount retires queued initialization', async () => {
    const { unmount } = open();
    let identityReads = 0;
    mockServer.use(
      http.get(identityUrl, () => {
        identityReads++;
        return HttpResponse.json(user);
      }),
    );
    unmount();
    await Promise.resolve();
    expect(identityReads).toBe(0);
  });

  it.each([409, 412])(
    'keeps an unresolved command exact when a POST %s has malformed problem details',
    async (status) => {
      const { event, onCreated } = open();
      const requests = captureCopies((count) =>
        count === 1
          ? HttpResponse.error()
          : count === 2
            ? HttpResponse.json({ malformed: true }, { status })
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
      expect(requests[1]).toEqual(requests[0]);
      await event.click(
        screen.getByRole('button', { name: 'Retry exact copy' }),
      );
      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
      });
      expect(requests).toHaveLength(3);
      expect(requests[2]).toEqual(requests[0]);
    },
  );

  it('retains ordinary name intent rather than replaying a definitively conflicted unresolved command', async () => {
    const { event, onCreated } = open();
    const requests = captureCopies((count) =>
      count === 1
        ? HttpResponse.error()
        : count === 2
          ? problem(409, 'request.idempotency_conflict')
          : created(),
    );
    await screen.findByText(/Source: saved draft revision 1/u);
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await expectRecovery();
    await event.click(screen.getByRole('button', { name: 'Retry exact copy' }));
    await screen.findByText(/already used with different details/u);
    expect(screen.getByLabelText('Copy name')).toHaveValue('Source (copy)');
    expect(requests[1]).toEqual(requests[0]);
    expect(requests).toHaveLength(2);
    expect(onCreated).not.toHaveBeenCalled();
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
    });
    expect(requests[2]?.key).not.toEqual(requests[0]?.key);
  });

  it('recovers an unresolved stale command only through refetch and new explicit confirmation', async () => {
    const { event, onCreated } = open();
    const requests = captureCopies((count) =>
      count === 1
        ? HttpResponse.error()
        : count === 2
          ? staleResponse()
          : created(),
    );
    await screen.findByText(/Source: saved draft revision 1/u);
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await expectRecovery();
    // The first request never committed; now a real mutation rejection is definitive
    // for this retry, unlike an authority read outage or a retained accepted result.
    await event.click(screen.getByRole('button', { name: 'Retry exact copy' }));
    await screen.findByText(
      /an older copy may still exist if its receipt expired/u,
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(onCreated).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Retry exact copy' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Copy name')).toHaveValue('Source (copy)');
    mockServer.use(
      http.get(`${api}/workflows/${workflowId}/draft`, () =>
        HttpResponse.json(
          { ...draftBody(workflowId), revision: 2 },
          { headers: { etag: nextTag } },
        ),
      ),
    );
    await event.click(
      screen.getByRole('button', { name: 'Read current saved draft' }),
    );
    await screen.findByText(/Source: saved draft revision 2/u);
    expect(requests).toHaveLength(2);
    expect(onCreated).not.toHaveBeenCalled();
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
    });
    expect(requests).toHaveLength(3);
    expect(requests[2]?.body).toEqual(requests[0]?.body);
    expect(requests[2]?.key).not.toEqual(requests[0]?.key);
    expect(requests[2]?.tag).toEqual(nextTag);
  });

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
      // Even if its receipt expired and a POST would now reject, a known 201
      // recovers its destination through fresh authority reads, not another write.
      mockServer.use(
        http.post(
          `${api}/workflows/${workflowId}/duplicate`,
          async ({ request }) => {
            requests.push({
              body: await request.json(),
              key: request.headers.get('Idempotency-Key'),
              tag: request.headers.get('If-Match'),
            });
            return staleResponse();
          },
        ),
      );
      await event.click(
        screen.getByRole('button', { name: 'Retry exact copy' }),
      );
      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
      });
      expect(requests).toHaveLength(1);
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
