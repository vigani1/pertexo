import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  draftResponse,
  emptyGraph,
  etag,
  etagB,
  etagC,
  graphWithNode,
  installQueries,
  olderVersionId,
  problem,
  stepNode,
  version,
  versionId,
  workflowApi,
  workflowId,
  workspaceId,
} from './workflow-settings.fixtures';

const versionsPath = `/w/${workspaceId}/workflows/${workflowId}/versions`;

function restoreHandler(
  respond: (precondition: string) => ReturnType<typeof draftResponse>,
) {
  return http.post(
    `${workflowApi}/versions/${versionId}/restore`,
    ({ request }) => respond(request.headers.get('if-match') ?? ''),
  );
}

async function openRestore() {
  const event = userEvent.setup();
  await event.click(
    await screen.findByRole('button', { name: 'Restore to draft' }),
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Restore v1 to the draft?',
  });
  expect(dialog).toHaveTextContent(
    'Your draft will be replaced by v1. Published versions don’t change.',
  );
  await event.click(
    within(dialog).getByRole('button', { name: 'Restore draft' }),
  );
  return event;
}

describe('workflow versions tab', () => {
  it('threads versions newest first, marks the live one and previews what changed', async () => {
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/versions`, () =>
        HttpResponse.json({
          items: [
            version(olderVersionId, 1, {
              ...emptyGraph,
              nodes: [
                stepNode('hook', 'core.webhook'),
                stepNode('old', 'core.set', 'Tidy fields'),
              ],
            }),
            version(versionId, 2, {
              ...emptyGraph,
              nodes: [
                stepNode('hook', 'core.webhook'),
                stepNode('call', 'http.request', 'Call API'),
              ],
            }),
          ],
          nextCursor: null,
        }),
      ),
    );
    renderApp(versionsPath);
    const event = userEvent.setup();
    const thread = await screen.findByRole('list', {
      name: 'Published versions',
    });
    const [newest, oldest] = within(thread).getAllByRole('listitem');
    expect(newest).toHaveTextContent('v2');
    expect(newest).toHaveTextContent('Live');
    expect(newest).toHaveTextContent('2 steps');
    expect(oldest).toHaveTextContent('v1');
    expect(oldest).not.toHaveTextContent('Live');

    await event.click(
      within(thread).getByRole('button', { name: 'Preview v2' }),
    );
    const preview = await screen.findByRole('dialog', { name: 'v2' });
    // Listed once among the steps and once as added since v1.
    expect(within(preview).getAllByText('Call API')).toHaveLength(2);
    expect(within(preview).getByText('Added')).toBeVisible();
    expect(within(preview).queryByText('Changed')).not.toBeInTheDocument();
    expect(within(preview).getByText('Removed')).toBeVisible();
    expect(within(preview).getByText('Tidy fields')).toBeVisible();
    expect(within(preview).getByText('Trigger · Webhook')).toBeVisible();
  });

  it('restores a version with a freshly read draft ETag', async () => {
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/draft`, () => draftResponse(emptyGraph, etag)),
      restoreHandler((precondition) => {
        expect(precondition).toBe(etag);
        return draftResponse(emptyGraph, etagB);
      }),
    );
    renderApp(versionsPath);
    await openRestore();
    expect(await screen.findByText('Draft restored from v1')).toBeVisible();
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Restore v1 to the draft?' }),
      ).not.toBeInTheDocument();
    });
  });

  it('does not overwrite an intervening draft after a lost restore acknowledgement', async () => {
    installQueries();
    const intervening = graphWithNode('another-tab');
    let currentGraph: unknown = graphWithNode('original');
    let currentEtag = etag;
    let restoreCalls = 0;
    mockServer.use(
      http.get(`${workflowApi}/draft`, () =>
        draftResponse(currentGraph, currentEtag),
      ),
      http.post(
        `${workflowApi}/versions/${versionId}/restore`,
        ({ request }) => {
          restoreCalls += 1;
          expect(request.headers.get('if-match')).toBe(etag);
          currentGraph = intervening;
          currentEtag = etagC;
          return HttpResponse.error();
        },
      ),
    );
    renderApp(versionsPath);
    const event = await openRestore();
    expect(
      await screen.findByText(/draft changed while this restore was pending/u),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Replace newer draft' }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(restoreCalls).toBe(1);
    expect(currentGraph).toEqual(intervening);
  });

  it('recovers from 412 only through an explicit replacement confirmation', async () => {
    installQueries();
    let currentGraph: unknown = graphWithNode('original');
    let currentEtag = etag;
    const preconditions: string[] = [];
    mockServer.use(
      http.get(`${workflowApi}/draft`, () =>
        draftResponse(currentGraph, currentEtag),
      ),
      restoreHandler((precondition) => {
        preconditions.push(precondition);
        if (preconditions.length === 1) {
          currentGraph = graphWithNode('concurrent');
          currentEtag = etagB;
          return problem(412, 'workflow.revision_conflict');
        }
        expect(precondition).toBe(etagB);
        currentGraph = emptyGraph;
        currentEtag = etagC;
        return draftResponse(currentGraph, currentEtag);
      }),
    );
    renderApp(versionsPath);
    const event = await openRestore();
    expect(
      await screen.findByRole('button', { name: 'Replace newer draft' }),
    ).toBeVisible();
    expect(preconditions).toEqual([etag]);
    await event.click(
      screen.getByRole('button', { name: 'Replace newer draft' }),
    );
    await waitFor(() => {
      expect(preconditions).toEqual([etag, etagB]);
    });
    expect(await screen.findByText('Draft restored from v1')).toBeVisible();
    expect(currentGraph).toEqual(emptyGraph);
  });

  it('offers previews but not restore to people who can’t change the draft', async () => {
    installQueries([]);
    renderApp(versionsPath);
    expect(
      await screen.findByRole('button', { name: 'Preview v1' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Restore to draft' }),
    ).not.toBeInTheDocument();
  });
});
