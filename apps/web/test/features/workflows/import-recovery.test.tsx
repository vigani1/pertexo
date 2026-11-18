import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import { workflowShapeQueryOptions } from '@/features/workflows/data/workflows.queries';
import { createApiClient } from '@/lib/api/client';
import { act, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { gatewayFailures } from '../../support/fixtures/gateway-failures';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import { mountList, prepare, retireHistories } from './import-recovery/fixture';
import {
  api,
  userId,
  versionId,
  workflowId,
  workspaceId,
} from './list/fixtures';

afterEach(() => {
  for (const retire of retireHistories.splice(0)) retire();
});

describe('Retrying an import whose outcome is unknown', () => {
  it('keeps a lost import through unrelated failures, an example choice and Close/reopen, and only replays its exact body and key on request', async () => {
    const attempts: { body: unknown; key: string | null }[] = [];
    let accept = false;
    mockServer.use(
      http.post(`${api}/workflows/import`, async ({ request }) => {
        attempts.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        // The server accepted the first command, but its responses are lost
        // until the test lets one through.
        return accept
          ? HttpResponse.json({ workflowId: versionId }, { status: 201 })
          : HttpResponse.error();
      }),
      http.get(`${api}/workflows/${workflowId}/draft`, () =>
        HttpResponse.json(
          {
            type: 'urn:pertexo:problem:resource.not_found',
            title: 'Not found',
            status: 404,
            code: 'resource.not_found',
            requestId: 'optional-row-preview',
          },
          { status: 404 },
        ),
      ),
    );
    const { event, queryClient, onCreated } = mountList();
    await prepare(event);
    await screen.findByRole('button', { name: 'Retry exact import' });

    // An unrelated workflow preview being unavailable keeps the pending import.
    const options = workflowShapeQueryOptions(
      createApiClient({ fetch: testFetch, readCsrfToken: () => undefined }),
      userId,
      workspaceId,
      workflowId,
    );
    await act(async () => {
      await expect(
        queryClient.query({ ...options, retry: false }),
      ).rejects.toMatchObject({ status: 404 });
    });
    expect(screen.getByLabelText('New workflow name')).toHaveValue(
      'Frozen recovery draft',
    );
    await event.click(
      screen.getByRole('button', { name: 'Retry exact import' }),
    );
    await screen.findByRole('button', { name: 'Retry exact import' });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);

    // Choosing an example reopens the unresolved file import instead.
    await event.click(screen.getByRole('button', { name: 'Close' }));
    const example = CURATED_WORKFLOW_TEMPLATES[0];
    if (example === undefined) throw new Error('Expected a curated example');
    await event.click(
      screen.getByRole('button', { name: new RegExp(example.title, 'u') }),
    );
    await event.click(
      await screen.findByRole('button', { name: 'Retry exact import' }),
    );
    await screen.findByRole('button', { name: 'Retry exact import' });
    expect(attempts).toHaveLength(3);
    expect(attempts[2]).toEqual(attempts[0]);
    expect(screen.getByLabelText('New workflow name')).toHaveValue(
      'Frozen recovery draft',
    );

    // Close and reopen keep it too, and nothing retries on its own.
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
    expect(attempts).toHaveLength(3);
    expect(screen.getByLabelText('New workflow name')).toBeDisabled();
    accept = true;
    await event.click(retry);
    await screen.findByRole('button', { name: 'Open imported workflow' });
    expect(attempts).toHaveLength(4);
    expect(attempts[3]).toEqual(attempts[0]);
    expect(attempts[0]?.key).toBeTruthy();
    await event.click(
      screen.getByRole('button', { name: 'Open imported workflow' }),
    );
    expect(onCreated).toHaveBeenCalledWith(versionId);
    expect(attempts).toHaveLength(4);
  });

  it.each(gatewayFailures)(
    'imports one workflow when the person retries after a %s',
    async (_status, gatewayFailure) => {
      // The server keeps one workflow per idempotency key, like the API does.
      const imported = new Map<string | null, unknown>();
      const attempts: (string | null)[] = [];
      mockServer.use(
        http.post(`${api}/workflows/import`, async ({ request }) => {
          const key = request.headers.get('idempotency-key');
          attempts.push(key);
          imported.set(key, await request.json());
          return attempts.length === 1
            ? gatewayFailure()
            : HttpResponse.json({ workflowId: versionId }, { status: 201 });
        }),
      );
      const { event, onCreated } = mountList();
      await prepare(event);

      await event.click(
        await screen.findByRole('button', { name: 'Retry exact import' }),
      );
      await event.click(
        await screen.findByRole('button', { name: 'Open imported workflow' }),
      );

      expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toBeTruthy();
      expect(imported.size).toBe(1);
      expect([...imported.values()][0]).toMatchObject({
        name: 'Frozen recovery draft',
      });
    },
  );

  it.each([
    {
      status: 409,
      code: 'workflow.portability_compatibility_conflict',
      detail:
        'The destination catalog changed. Preview this import again before creating its draft.',
    },
    {
      status: 422,
      code: 'workflow.portability_invalid',
      detail:
        'The imported content needs repair. Preview it again and review the compatibility findings.',
    },
  ])(
    'explains a $status import refusal and previews again before sending a new reviewed import',
    async ({ status, code, detail }) => {
      const attempts: { body: unknown; key: string | null }[] = [];
      mockServer.use(
        http.post(`${api}/workflows/import`, async ({ request }) => {
          attempts.push({
            body: await request.json(),
            key: request.headers.get('idempotency-key'),
          });
          return attempts.length === 1
            ? HttpResponse.json(
                {
                  type: `urn:pertexo:problem:${code}`,
                  title: 'Import changed',
                  status,
                  code,
                  detail,
                  requestId: 'import-catalog-changed',
                },
                {
                  status,
                  headers: { 'content-type': 'application/problem+json' },
                },
              )
            : HttpResponse.json({ workflowId }, { status: 201 });
        }),
      );
      const { event } = mountList();
      let previews = 0;
      mockServer.use(
        http.post(`${api}/workflows/import/preview`, () => {
          previews += 1;
          return HttpResponse.json({
            manifestDigest: 'b'.repeat(64),
            compatibilityFingerprint: `wf-compat:sha256:${(previews === 1 ? 'a' : 'c').repeat(64)}`,
            compatible: true,
            issues: [],
            truncated: false,
            connectionSlots: [],
          });
        }),
      );
      await prepare(event);
      expect(await screen.findByText(detail)).toBeVisible();
      expect(screen.getByLabelText('New workflow name')).toHaveValue(
        'Frozen recovery draft',
      );
      expect(
        screen.getByRole('button', { name: 'Import unpublished draft' }),
      ).toBeDisabled();
      await event.click(screen.getByRole('button', { name: 'Preview again' }));
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Import unpublished draft' }),
        ).toBeEnabled();
      });
      await event.click(
        screen.getByRole('button', { name: 'Import unpublished draft' }),
      );
      expect(
        await screen.findByRole('button', { name: 'Open imported workflow' }),
      ).toBeVisible();
      expect(previews).toBe(2);
      expect(attempts[1]?.body).toMatchObject({
        name: 'Frozen recovery draft',
        expectedCompatibilityFingerprint: `wf-compat:sha256:${'c'.repeat(64)}`,
      });
      expect(attempts[1]?.key).not.toBe(attempts[0]?.key);
    },
  );
});
