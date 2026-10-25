import { screen, waitFor } from '@testing-library/react';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../support/mock-server';

import {
  captureCopies,
  created,
  expectRecovery,
  identityUrl,
  nextTag,
  open,
  outages,
  staleResponse,
  transient,
} from './duplicate-recovery/fixture';

import {
  api,
  discoveryHandlers,
  draftBody,
  problem,
  user,
  versionId,
  workflowId,
} from './list/fixtures';

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
      const requests = captureCopies((count) => {
        if (count === 1) return HttpResponse.error();
        if (count === 2)
          return HttpResponse.json({ malformed: true }, { status });
        return created();
      });
      await screen.findByText(/last saved, revision 1/u);
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
    const requests = captureCopies((count) => {
      if (count === 1) return HttpResponse.error();
      if (count === 2) return problem(409, 'request.idempotency_conflict');
      return created();
    });
    await screen.findByText(/last saved, revision 1/u);
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
    const requests = captureCopies((count) => {
      if (count === 1) return HttpResponse.error();
      if (count === 2) return staleResponse();
      return created();
    });
    await screen.findByText(/last saved, revision 1/u);
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
    await screen.findByText(/last saved, revision 2/u);
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
      await screen.findByText(/last saved, revision 1/u);
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
      await screen.findByText(/last saved, revision 1/u);
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
      const requests = captureCopies((count) => {
        if (count === 1) return HttpResponse.error();
        if (count === 2) return transient(status);
        return created();
      });
      await screen.findByText(/last saved, revision 1/u);
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
      await screen.findByText(/last saved, revision 1/u);
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
    await screen.findByText(/last saved, revision 1/u);
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
