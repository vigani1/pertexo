import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  CURATED_WORKFLOW_TEMPLATES,
  FIRST_RUN_TEMPLATE_ID,
} from '@pertexo/templates';
import { coldStart } from '../../../support/fixtures/run';
import { mockServer } from '../../../support/mock-server';
import { renderLoadedApp } from '../../../support/render-app';
import {
  api,
  curatedCatalog,
  discoveryHandlers,
  draftHandler,
  organizedPage,
  summary,
  workflowId,
  workspaceId,
} from './fixtures';

const fingerprint = `wf-compat:sha256:${'c'.repeat(64)}`;
const firstRun = CURATED_WORKFLOW_TEMPLATES.find(
  (template) => template.templateId === FIRST_RUN_TEMPLATE_ID,
);
const [webhookExample] = CURATED_WORKFLOW_TEMPLATES;
if (firstRun === undefined || webhookExample === undefined)
  throw new Error('Missing curated examples');

type Sent = Readonly<{ key: string | null; body: Record<string, unknown> }>;

/** An empty workspace whose import endpoints answer as `answers` says. */
function workspace(
  answers: Readonly<{
    compatible?: boolean;
    importFails?: number;
  }> = {},
) {
  const previews: Record<string, unknown>[] = [];
  const imports: Sent[] = [];
  mockServer.use(
    ...discoveryHandlers(),
    http.get(`${api}/workflows`, () =>
      HttpResponse.json(organizedPage({ items: [], nextCursor: null })),
    ),
    http.get(`${api}/workflows/${workflowId}`, () =>
      HttpResponse.json({
        workflow: summary(workflowId, firstRun?.title ?? ''),
      }),
    ),
    draftHandler(),
    http.post(`${api}/workflows/import/preview`, async ({ request }) => {
      previews.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({
        manifestDigest: 'b'.repeat(64),
        compatibilityFingerprint: fingerprint,
        compatible: answers.compatible ?? true,
        issues: [],
        truncated: false,
        connectionSlots: [],
      });
    }),
    http.post(`${api}/workflows/import`, async ({ request }) => {
      imports.push({
        key: request.headers.get('idempotency-key'),
        body: (await request.json()) as Record<string, unknown>,
      });
      if (imports.length <= (answers.importFails ?? 0))
        return HttpResponse.error();
      return HttpResponse.json({ workflowId }, { status: 201 });
    }),
  );
  mockServer.use(
    http.get('http://pertexo.test/v1/node-definitions', () =>
      HttpResponse.json(curatedCatalog()),
    ),
  );
  return { previews, imports };
}

async function chooseOnEmptyList(title: string) {
  const app = await renderLoadedApp(`/w/${workspaceId}/workflows`);
  const empty = await screen.findByRole(
    'region',
    { name: 'Weave your first workflow' },
    coldStart,
  );
  const event = userEvent.setup();
  await event.click(
    within(empty).getByRole('button', { name: `Use this example: ${title}` }),
  );
  return { ...app, event };
}

const requested: string[] = [];
mockServer.events.on('request:start', ({ request }) => {
  requested.push(request.url);
});

describe('examples with nothing to set up', () => {
  it('creates the first-run example in one click and opens it in Build with its guide', async () => {
    const sent = workspace();
    const { router } = await chooseOnEmptyList(firstRun.title);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/workflows/${workflowId}`,
      );
    });
    expect(router.state.location.search).toEqual({ guide: 'first-run' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sent.previews).toHaveLength(1);
    expect(sent.imports).toHaveLength(1);
    expect(sent.imports[0]?.body).toMatchObject({
      name: firstRun.title,
      bindings: [],
      expectedCompatibilityFingerprint: fingerprint,
      templateOrigin: {
        templateId: FIRST_RUN_TEMPLATE_ID,
        templateVersion: firstRun.templateVersion,
        baseManifestDigest: firstRun.baseManifestDigest,
      },
    });
    const guide = await screen.findByRole(
      'region',
      { name: 'Your first run' },
      coldStart,
    );
    // product-ux-28: the new workflow is read by its ID, never "undefined".
    expect(requested.filter((url) => url.includes('undefined'))).toEqual([]);
    expect(within(guide).getByText('Publish it').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('opens another setup-free example in Build without the guide', async () => {
    workspace();
    const { router } = await chooseOnEmptyList(webhookExample.title);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/workflows/${workflowId}`,
      );
    });
    expect(router.state.location.search).toEqual({});
  });

  it('resends the same create after a lost answer, so it makes one copy', async () => {
    const sent = workspace({ importFails: 1 });
    const { router, event } = await chooseOnEmptyList(firstRun.title);

    expect(
      (
        await screen.findAllByText(
          /couldn’t confirm whether the example was created/u,
        )
      )[0],
    ).toBeVisible();
    // The notification's own action (its toast is aria-hidden while it
    // animates in under jsdom).
    await event.click(screen.getByText('Try again', { selector: 'button' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/workflows/${workflowId}`,
      );
    });
    expect(sent.imports).toHaveLength(2);
    expect(sent.imports[1]?.key).toBe(sent.imports[0]?.key);
  });

  it('opens the example’s review when this workspace can’t build it as is', async () => {
    const sent = workspace({ compatible: false });
    await chooseOnEmptyList(firstRun.title);
    expect(
      await screen.findByRole('dialog', { name: 'Start from an example' }),
    ).toBeVisible();
    expect(sent.imports).toHaveLength(0);
  });
});
