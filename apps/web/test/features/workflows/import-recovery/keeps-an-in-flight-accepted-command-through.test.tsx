import { workflowKeys } from '@/features/workflows/queries.public';

import { ApiError } from '@/lib/api/error';

import { act, screen, waitFor } from '@testing-library/react';

import { http, HttpResponse } from 'msw';

import { afterEach, describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { mountList, prepare, retireHistories } from './fixture';

import {
  api,
  userId,
  versionId,
  workflowId,
  workspaceId,
} from '../list/fixtures';

afterEach(() => {
  for (const retire of retireHistories.splice(0)) retire();
});

describe('Workflow list owns import recovery across dialog dismissal', () => {
  it('keeps an in-flight accepted command through Cancel/reopen without sending a replacement or auto-retrying', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempts: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post(`${api}/workflows/import`, async ({ request }) => {
        attempts.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        if (attempts.length === 1) {
          await held;
          return HttpResponse.error();
        }
        return HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event } = mountList();
    await prepare(event);
    await waitFor(() => {
      expect(attempts).toHaveLength(1);
    });
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Import workflow' }),
      ).not.toBeInTheDocument(),
    );
    await event.click(screen.getByRole('button', { name: 'Import workflow…' }));
    release();
    const retry = await screen.findByRole('button', {
      name: 'Retry exact import',
    });
    expect(attempts).toHaveLength(1);
    await event.click(retry);
    await screen.findByRole('button', { name: 'Open imported workflow' });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
  });
  it('clears retained private intent after access loss while dismissed and fences a late accepted response', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posted = 0;
    let serverSettled!: () => void;
    const serverResponse = new Promise<void>((resolve) => {
      serverSettled = resolve;
    });
    let transportSettled!: () => void;
    const transportResponse = new Promise<void>((resolve) => {
      transportSettled = resolve;
    });
    mockServer.use(
      http.post(`${api}/workflows/import`, async () => {
        posted += 1;
        await held;
        serverSettled();
        return HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event, queryClient, onCreated } = mountList(
      false,
      transportSettled,
    );
    await prepare(event);
    await waitFor(() => {
      expect(posted).toBe(1);
    });
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Import workflow' }),
      ).not.toBeInTheDocument(),
    );
    await queryClient
      .query({
        queryKey: workflowKeys.detail(userId, workspaceId, workflowId),
        queryFn: () =>
          Promise.reject(
            new ApiError({ kind: 'problem', message: 'Denied', status: 403 }),
          ),
        retry: false,
      })
      .catch(() => undefined);
    await act(async () => {
      release();
      await serverResponse;
      await transportResponse;
    });
    await event.click(screen.getByRole('button', { name: 'Import workflow…' }));
    await screen.findByText(/Access changed/u);
    expect(
      screen.queryByLabelText('Complete imported graph'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('New workflow name'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry exact import' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open imported workflow' }),
    ).not.toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(posted).toBe(1);
  });
  it('blocks same-workspace departure while uncertain, offers Stay/reopen, and releases a confirmed command without another POST', async () => {
    const attempts: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post(`${api}/workflows/import`, async ({ request }) => {
        attempts.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        return attempts.length === 1
          ? HttpResponse.error()
          : HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event, router } = mountList(true);
    await prepare(event);
    await screen.findByRole('button', { name: 'Retry exact import' });
    await event.click(screen.getByRole('button', { name: 'Close' }));
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    void router.navigate({ to: '/w/$workspaceId', params: { workspaceId } });
    await screen.findByRole('heading', {
      name: 'Resolve the import before leaving',
    });
    expect(router.state.location.pathname).toBe(`/w/${workspaceId}/workflows`);
    await event.click(screen.getByRole('button', { name: 'Stay here' }));
    expect(
      screen.queryByRole('heading', { name: 'Destination page' }),
    ).not.toBeInTheDocument();
    void router.navigate({ to: '/w/$workspaceId', params: { workspaceId } });
    await event.click(
      await screen.findByRole('button', { name: 'Reopen import' }),
    );
    expect(attempts).toHaveLength(1);
    await event.click(
      await screen.findByRole('button', { name: 'Retry exact import' }),
    );
    await screen.findByRole('button', { name: 'Open imported workflow' });
    expect(attempts[1]).toEqual(attempts[0]);
    await event.click(screen.getByRole('button', { name: 'Close' }));
    await event.click(screen.getByRole('button', { name: 'Import workflow…' }));
    await screen.findByRole('button', { name: 'Open imported workflow' });
    expect(attempts).toHaveLength(2);
    const settledUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(settledUnload);
    expect(settledUnload.defaultPrevented).toBe(false);
    await router.navigate({ to: '/w/$workspaceId', params: { workspaceId } });
    await screen.findByRole('heading', { name: 'Destination page' });
  });
  it.each(['session departure', 'workspace change'] as const)(
    'does not prevent %s during sending, and fences the late accepted response',
    async (departure) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let posted = 0;
      let serverSettled!: () => void;
      const serverResponse = new Promise<void>((resolve) => {
        serverSettled = resolve;
      });
      let transportSettled!: () => void;
      const transportResponse = new Promise<void>((resolve) => {
        transportSettled = resolve;
      });
      mockServer.use(
        http.post(`${api}/workflows/import`, async () => {
          posted += 1;
          await held;
          serverSettled();
          return HttpResponse.json({ workflowId: versionId }, { status: 201 });
        }),
      );
      const { event, router, onCreated } = mountList(true, transportSettled);
      await prepare(event);
      await waitFor(() => {
        expect(posted).toBe(1);
      });
      await event.click(screen.getByRole('button', { name: 'Cancel' }));
      void router.navigate({ to: '/w/$workspaceId', params: { workspaceId } });
      await screen.findByRole('heading', {
        name: 'Resolve the import before leaving',
      });
      await event.click(screen.getByRole('button', { name: 'Stay here' }));
      if (departure === 'session departure') {
        await router.navigate({ to: '/login' });
        await screen.findByRole('heading', { name: 'Sign in destination' });
      } else {
        await router.navigate({
          to: '/w/$workspaceId',
          params: { workspaceId: versionId },
        });
        await screen.findByRole('heading', { name: 'Destination page' });
        expect(router.state.location.pathname).toBe(`/w/${versionId}`);
      }
      await act(async () => {
        release();
        await serverResponse;
        await transportResponse;
      });
      expect(onCreated).not.toHaveBeenCalled();
      expect(posted).toBe(1);
      expect(
        screen.queryByRole('button', { name: 'Open imported workflow' }),
      ).not.toBeInTheDocument();
    },
  );
  it('retires hidden recovery on a cross-tab session change and fences an accepted response', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posted = 0;
    let serverSettled!: () => void;
    const serverResponse = new Promise<void>((resolve) => {
      serverSettled = resolve;
    });
    let transportSettled!: () => void;
    const transportResponse = new Promise<void>((resolve) => {
      transportSettled = resolve;
    });
    mockServer.use(
      http.post(`${api}/workflows/import`, async () => {
        posted += 1;
        await held;
        serverSettled();
        return HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event, onCreated } = mountList(false, transportSettled);
    await prepare(event);
    await waitFor(() => {
      expect(posted).toBe(1);
    });
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'pertexo:auth-session-change',
        newValue: JSON.stringify({
          event: 'changed',
          generation: 'new-session',
          sender: 'other-tab',
        }),
      }),
    );
    await act(async () => {
      release();
      await serverResponse;
      await transportResponse;
    });
    await event.click(screen.getByRole('button', { name: 'Import workflow…' }));
    await screen.findByText(/Access changed/u);
    expect(
      screen.queryByLabelText('New workflow name'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry exact import' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open imported workflow' }),
    ).not.toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(posted).toBe(1);
  });
});
