import { workflowKeys } from '@/features/workflows/workflows-queries.public';

import { ApiError } from '@/lib/api/error';

import { screen, waitFor } from '@testing-library/react';

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
  it.each(['sending', 'uncertain', 'refused'] as const)(
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
          return state === 'refused'
            ? problem(403, 'auth.forbidden')
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
      else {
        await screen.findByText(/Your role doesn’t allow/u);
        expect(screen.getByLabelText('New workflow name')).toBeEnabled();
      }
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
  it('clears a new local draft after an authoritative read loses access following reset', async () => {
    let posted = 0;
    mockServer.use(
      http.post(`${api}/workflows/import`, () => {
        posted++;
        return HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event, queryClient, onCreated } = mountList();
    await prepare(event);
    await screen.findByRole('button', { name: 'Open imported workflow' });
    await event.click(
      screen.getByRole('button', { name: 'Start another import' }),
    );
    await event.upload(
      screen.getByLabelText('Workflow JSON file'),
      new File([JSON.stringify(manifest)], 'new.json', {
        type: 'application/json',
      }),
    );
    await screen.findByLabelText('Complete imported graph');
    await event.type(
      screen.getByLabelText('New workflow name'),
      'Private next draft',
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
    await screen.findByText(/Access changed/u);
    expect(
      screen.queryByLabelText('New workflow name'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open imported workflow' }),
    ).not.toBeInTheDocument();
    expect(posted).toBe(1);
    expect(onCreated).not.toHaveBeenCalled();
  });
  it('starts another local draft without depending on a separate session verification request', async () => {
    let posted = 0;
    mockServer.use(
      http.post(`${api}/workflows/import`, () => {
        posted++;
        return HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event } = mountList();
    await prepare(event);
    await screen.findByRole('button', { name: 'Open imported workflow' });
    let checks = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () => {
        checks++;
        return HttpResponse.error();
      }),
    );
    await event.click(
      screen.getByRole('button', { name: 'Start another import' }),
    );
    expect(screen.getByLabelText('New workflow name')).toHaveValue('');
    expect(screen.getByLabelText('New workflow name')).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: 'Open imported workflow' }),
    ).not.toBeInTheDocument();
    expect(checks).toBe(0);
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
