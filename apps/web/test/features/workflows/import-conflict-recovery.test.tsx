import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { api, workflowId } from './list/fixtures';
import { mountList, prepare } from './import-recovery/fixture';

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
