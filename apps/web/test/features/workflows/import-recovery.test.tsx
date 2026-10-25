import { workflowKeys } from '@/features/workflows/queries.public';

import { ApiError } from '@/lib/api/error';

import { act, screen, waitFor } from '@testing-library/react';

import { http, HttpResponse } from 'msw';

import { afterEach, describe, expect, it } from 'vitest';

import { mockServer } from '../../support/mock-server';

import {
  fingerprint,
  manifest,
  mountList,
  prepare,
  retireHistories,
} from './import-recovery/fixture';

import {
  api,
  problem,
  user,
  userId,
  versionId,
  workflowId,
  workspaceId,
} from './list/fixtures';

afterEach(() => {
  for (const retire of retireHistories.splice(0)) retire();
});

describe('Workflow list owns import recovery across dialog dismissal', () => {
  it('starts another import only after confirmed recovery, clears setup without POST, and creates a fresh explicit key', async () => {
    const attempts: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post(`${api}/workflows/import`, async ({ request }) => {
        attempts.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        return HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event } = mountList();
    await prepare(event);
    await screen.findByRole('button', { name: 'Open imported workflow' });
    await event.click(screen.getByRole('button', { name: 'Close' }));
    await event.click(screen.getByRole('button', { name: 'Import workflow…' }));
    await screen.findByRole('button', { name: 'Open imported workflow' });
    expect(attempts).toHaveLength(1);
    await event.click(
      screen.getByRole('button', { name: 'Start another import' }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('New workflow name')).toBeEnabled();
    });
    expect(screen.getByLabelText('New workflow name')).toHaveValue('');
    expect(screen.getByLabelText('Workflow JSON file')).toHaveValue('');
    expect(
      screen.queryByLabelText('Complete imported graph'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Compatible with this workspace/u),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open imported workflow' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Start another import' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Import unpublished draft' }),
    ).toBeDisabled();
    expect(attempts).toHaveLength(1);
    await event.upload(
      screen.getByLabelText('Workflow JSON file'),
      new File([JSON.stringify(manifest)], 'second.json', {
        type: 'application/json',
      }),
    );
    await screen.findByLabelText('Complete imported graph');
    await event.type(
      screen.getByLabelText('New workflow name'),
      'Deliberate second draft',
    );
    await event.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByText(/Compatible with this workspace/u);
    expect(attempts).toHaveLength(1);
    await event.click(
      screen.getByRole('button', { name: 'Import unpublished draft' }),
    );
    await screen.findByRole('button', { name: 'Open imported workflow' });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.key).toBeTruthy();
    expect(attempts[1]?.key).not.toBe(attempts[0]?.key);
    expect(attempts[1]?.body).toEqual({
      manifest,
      bindings: [],
      name: 'Deliberate second draft',
      expectedCompatibilityFingerprint: fingerprint,
    });
    await event.click(
      screen.getByRole('button', { name: 'Start another import' }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Workflow JSON file')).toHaveValue('');
    });
    expect(attempts).toHaveLength(2);
  });
  it.each(['sending', 'uncertain', 'denied'] as const)(
    'offers no reset action while %s',
    async (state) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let posted = 0;
      mockServer.use(
        http.post(`${api}/workflows/import`, async () => {
          posted += 1;
          if (state === 'sending') {
            await held;
            return HttpResponse.json(
              { workflowId: versionId },
              { status: 201 },
            );
          }
          return state === 'denied'
            ? problem(403, 'authorization.forbidden')
            : HttpResponse.error();
        }),
      );
      const { event } = mountList();
      await prepare(event);
      if (state === 'sending') {
        await waitFor(() => {
          expect(posted).toBe(1);
        });
        expect(
          screen.getByRole('button', { name: 'Importing…' }),
        ).toBeDisabled();
      } else if (state === 'uncertain')
        await screen.findByRole('button', { name: 'Retry exact import' });
      else await screen.findByText(/Access changed/u);
      expect(
        screen.queryByRole('button', { name: 'Start another import' }),
      ).not.toBeInTheDocument();
      expect(posted).toBe(1);
      if (state === 'sending') {
        release();
        await screen.findByRole('button', { name: 'Open imported workflow' });
      }
    },
  );
  it('retires reset on lost authority and fences a late successful verification without another POST', async () => {
    let posted = 0;
    mockServer.use(
      http.post(`${api}/workflows/import`, () => {
        posted += 1;
        return HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    let verifying = false;
    let release!: () => void;
    let serverSettled!: () => void;
    let transportSettled!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const serverResponse = new Promise<void>((resolve) => {
      serverSettled = resolve;
    });
    const transportResponse = new Promise<void>((resolve) => {
      transportSettled = resolve;
    });
    const { event, queryClient, onCreated } = mountList(
      false,
      undefined,
      () => {
        if (verifying) transportSettled();
      },
    );
    await prepare(event);
    await screen.findByRole('button', { name: 'Open imported workflow' });
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', async () => {
        verifying = true;
        await held;
        serverSettled();
        return HttpResponse.json(user);
      }),
    );
    await event.click(
      screen.getByRole('button', { name: 'Start another import' }),
    );
    await waitFor(() => {
      expect(verifying).toBe(true);
    });
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
    await screen.findByText(/Access changed/u);
    await act(async () => {
      release();
      await serverResponse;
      await transportResponse;
    });
    expect(
      screen.queryByLabelText('New workflow name'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Start another import' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open imported workflow' }),
    ).not.toBeInTheDocument();
    expect(posted).toBe(1);
    expect(onCreated).not.toHaveBeenCalled();
  });
  it('retains the known confirmed destination when reset authority verification has a transport outage', async () => {
    let posted = 0;
    mockServer.use(
      http.post(`${api}/workflows/import`, () => {
        posted += 1;
        return HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event } = mountList();
    await prepare(event);
    await screen.findByRole('button', { name: 'Open imported workflow' });
    let checked = false;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () => {
        checked = true;
        return HttpResponse.error();
      }),
    );
    await event.click(
      screen.getByRole('button', { name: 'Start another import' }),
    );
    await waitFor(() => {
      expect(checked).toBe(true);
    });
    await screen.findByRole('button', { name: 'Start another import' });
    expect(
      screen.getByRole('button', { name: 'Open imported workflow' }),
    ).toBeEnabled();
    expect(screen.getByLabelText('New workflow name')).toHaveValue(
      'Frozen recovery draft',
    );
    expect(screen.getByLabelText('New workflow name')).toBeDisabled();
    expect(posted).toBe(1);
  });
  it('retains a lost accepted response through Close/reopen and only manually replays the exact body/key', async () => {
    const attempts: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post(`${api}/workflows/import`, async ({ request }) => {
        attempts.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        // The server accepted the first command, but its response was lost.
        return attempts.length === 1
          ? HttpResponse.error()
          : HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event, onCreated } = mountList();
    await prepare(event);
    await screen.findByRole('button', { name: 'Retry exact import' });
    await event.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Import workflow' }),
      ).not.toBeInTheDocument(),
    );
    await event.click(screen.getByRole('button', { name: 'Import workflow…' }));
    const retry = await screen.findByRole('button', {
      name: 'Retry exact import',
    });
    expect(attempts).toHaveLength(1);
    expect(screen.getByLabelText('New workflow name')).toBeDisabled();
    await event.click(retry);
    await screen.findByRole('button', { name: 'Open imported workflow' });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]?.key).toBeTruthy();
    await event.click(
      screen.getByRole('button', { name: 'Open imported workflow' }),
    );
    expect(onCreated).toHaveBeenCalledWith(versionId);
    expect(attempts).toHaveLength(2);
  });
});
