import { workflowKeys } from '@/features/workflows/workflows-queries.public';
import { ApiError } from '@/lib/api/error';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { mockServer } from '../../../support/mock-server';
import {
  fingerprint,
  manifest,
  mountList,
  prepare,
  retireHistories,
} from './fixture';
import {
  api,
  problem,
  userId,
  versionId,
  workflowId,
  workspaceId,
} from '../list/fixtures';

afterEach(() => {
  for (const retire of retireHistories.splice(0)) retire();
});

describe('Starting another import', () => {
  it('starts another import only after confirmed recovery, without a POST or a session check, with a fresh key, and clears it when access is lost', async () => {
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
    const { event, queryClient, onCreated } = mountList();
    await prepare(event);
    await screen.findByRole('button', { name: 'Open imported workflow' });
    await event.click(screen.getByRole('button', { name: 'Close' }));
    await event.click(screen.getByRole('button', { name: 'Import workflow…' }));
    await screen.findByRole('button', { name: 'Open imported workflow' });
    expect(attempts).toHaveLength(1);

    // Starting over is local: it never waits on a session verification.
    let checking = true;
    let checks = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () => {
        if (!checking) return undefined;
        checks++;
        return HttpResponse.error();
      }),
    );
    await event.click(
      screen.getByRole('button', { name: 'Start another import' }),
    );
    expect(screen.getByLabelText('New workflow name')).toHaveValue('');
    expect(screen.getByLabelText('New workflow name')).toBeEnabled();
    expect(checks).toBe(0);
    checking = false;
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

    // An authoritative read losing access clears the next local draft.
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
    expect(attempts).toHaveLength(2);
    expect(onCreated).not.toHaveBeenCalled();
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
});
