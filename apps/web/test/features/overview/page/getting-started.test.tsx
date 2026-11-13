import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { FIRST_RUN_TEMPLATE_ID } from '@pertexo/templates';
import { coldStart, identityHandlers } from '../../../support/fixtures/run';
import { mockServer } from '../../../support/mock-server';
import { renderLoadedApp } from '../../../support/render-app';
import {
  readerCapabilities,
  runHandlers,
  workflow,
  workflowHandlers,
  workflowId,
  workspaceId,
} from './fixture';

const api = `http://pertexo.test/v1/workspaces/${workspaceId}`;

function checklist() {
  return screen.findByRole('region', { name: 'Getting started' }, coldStart);
}

describe('getting started on Home', () => {
  it('creates the first-run example in one click and opens its guided run', async () => {
    const imports: Record<string, unknown>[] = [];
    mockServer.use(
      ...identityHandlers([...readerCapabilities, 'workflow:create']),
      workflowHandlers([]),
      ...runHandlers({ problems: [], any: [] }),
      http.post(`${api}/workflows/import/preview`, () =>
        HttpResponse.json({
          manifestDigest: 'b'.repeat(64),
          compatibilityFingerprint: `wf-compat:sha256:${'c'.repeat(64)}`,
          compatible: true,
          issues: [],
          truncated: false,
          connectionSlots: [],
        }),
      ),
      http.post(`${api}/workflows/import`, async ({ request }) => {
        imports.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ workflowId }, { status: 201 });
      }),
    );
    const { router } = await renderLoadedApp(`/w/${workspaceId}`);
    const section = await checklist();
    await userEvent
      .setup()
      .click(within(section).getByRole('button', { name: 'Try the example' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/workflows/${workflowId}`,
      );
    });
    expect(router.state.location.search).toEqual({ guide: 'first-run' });
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      templateOrigin: { templateId: FIRST_RUN_TEMPLATE_ID },
    });
  });

  it('doesn’t offer the example to someone who can’t create workflows', async () => {
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      workflowHandlers([]),
      ...runHandlers({ problems: [], any: [] }),
    );
    await renderLoadedApp(`/w/${workspaceId}`);
    const section = await checklist();
    expect(
      within(section).queryByRole('button', { name: 'Try the example' }),
    ).toBeNull();
  });

  it('keeps the unfinished tasks, quieter, after the first run', async () => {
    mockServer.use(
      ...identityHandlers([...readerCapabilities, 'connection:read']),
      workflowHandlers([workflow({ publishedVersionId: crypto.randomUUID() })]),
      ...runHandlers(),
      http.get(`${api}/connections`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    await renderLoadedApp(`/w/${workspaceId}`);
    const section = await checklist();
    expect(
      await within(section).findByText('3 of 4 done.', { exact: false }),
    ).toBeVisible();
    const connection = within(section).getByRole('link', {
      name: 'Add a connection',
    });
    expect(connection).toHaveAttribute(
      'href',
      `/w/${workspaceId}/connections?add=any`,
    );
    expect(connection.closest('li')).toHaveTextContent('To do');
    expect(
      within(section).queryByRole('button', { name: 'Try the example' }),
    ).toBeNull();
  });

  it('goes away once every task is done', async () => {
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      workflowHandlers([workflow({ publishedVersionId: crypto.randomUUID() })]),
      ...runHandlers(),
    );
    await renderLoadedApp(`/w/${workspaceId}`);
    expect(
      await screen.findByRole(
        'heading',
        { name: 'Needs attention' },
        coldStart,
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole('region', { name: 'Getting started' }),
    ).toBeNull();
  });
});
