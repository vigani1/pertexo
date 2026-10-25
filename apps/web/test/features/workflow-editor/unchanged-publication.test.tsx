import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { findCanvas } from '../../support/fixtures/editor-actions';
import { graphWithNumericConfig } from '../../support/fixtures/editor-graph';
import {
  compatibility,
  editorHandlers,
  editorPath,
  etagA,
  etagB,
  numericDefinition,
  versionBody,
  versionId,
  workflowApi,
  workflowSummaryHandler,
} from '../../support/fixtures/workflow-editor';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';

const newerVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const graph = graphWithNumericConfig({ requiredCount: 1 });

function setup(liveId = versionId, matches = true, checkedEtag = etagA) {
  let saved = false;
  mockServer.use(
    ...editorHandlers(
      () => {
        saved = true;
      },
      { graph, definitions: [numericDefinition] },
    ),
  );
  mockServer.use(
    workflowSummaryHandler('Order intake', liveId),
    http.get(`${workflowApi}/versions`, () =>
      HttpResponse.json({
        items: [{ ...versionBody(newerVersionId, graph), versionNumber: 2 }],
        nextCursor: null,
      }),
    ),
    http.post(`${workflowApi}/validate`, () =>
      HttpResponse.json(
        {
          valid: true,
          issues: [],
          compatibility,
          currentPublication: {
            versionId: liveId,
            versionNumber: liveId === versionId ? 1 : 2,
            matchesDraft: matches && !saved,
          },
        },
        { headers: { etag: saved ? etagB : checkedEtag } },
      ),
    ),
  );
}

describe('unchanged publication feedback', { timeout: 30_000 }, () => {
  it('keeps an already-open publish lens from dispatching an unchanged saved draft', async () => {
    setup();
    let publishes = 0;
    mockServer.use(
      http.post(`${workflowApi}/publish`, () => {
        publishes += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    renderApp(editorPath, { strict: true });
    const event = userEvent.setup();
    await findCanvas();
    await event.click(
      await screen.findByRole('button', { name: 'Publish v3' }),
    );
    const lens = await screen.findByRole('dialog', { name: 'Publish v3' });
    await event.click(within(lens).getByRole('button', { name: 'Publish v3' }));
    expect(await within(lens).findByText(/No changes since v1/u)).toBeVisible();
    expect(
      within(lens).getByRole('button', { name: /Publish v3|Try again/u }),
    ).toBeDisabled();
    expect(publishes).toBe(0);
  });
  it('disables an exact live match even when a higher numbered version is retained, and enables editing', async () => {
    setup();
    renderApp(editorPath, { strict: true });
    const event = userEvent.setup();
    await findCanvas();
    const unchanged = await screen.findByRole('button', {
      name: 'No changes since v1',
    });
    expect(unchanged).toHaveAttribute('aria-disabled', 'true');
    await event.click(unchanged);
    expect(screen.queryByRole('dialog', { name: /Publish/u })).toBeNull();
    fireEvent.click(screen.getByLabelText('Numbers, Set fields'));
    const input = await screen.findByLabelText('Required count');
    await event.clear(input);
    expect(
      screen.getByRole('button', { name: 'Publish v3' }),
    ).not.toHaveAttribute('aria-disabled', 'true');
    await event.type(input, '2');
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'No changes since v1' }),
      ).toBeNull();
    });
  });

  it('does not disable publishing from a comparison of a different server snapshot', async () => {
    setup(versionId, true, etagB);
    renderApp(editorPath, { strict: true });
    await findCanvas();
    await screen.findByRole('button', { name: '1 issue' });
    expect(
      screen.getByRole('button', { name: 'Publish v3' }),
    ).not.toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.queryByRole('button', { name: 'No changes since v1' }),
    ).toBeNull();
  });

  it.each([versionId, newerVersionId])(
    'explains a reused v1 when the previous live version was %s',
    async (liveId) => {
      setup(liveId, false);
      let published = false;
      mockServer.use(
        http.post(`${workflowApi}/publish`, () => {
          published = true;
          mockServer.use(workflowSummaryHandler('Order intake', versionId));
          return HttpResponse.json({
            version: versionBody(versionId, graph),
            reused: true,
          });
        }),
      );
      renderApp(editorPath, { strict: true });
      const event = userEvent.setup();
      await findCanvas();
      await event.click(
        await screen.findByRole('button', { name: 'Publish v3' }),
      );
      const lens = await screen.findByRole('dialog', { name: 'Publish v3' });
      await event.click(
        within(lens).getByRole('button', { name: 'Publish v3' }),
      );
      expect(
        await screen.findByText(
          liveId === versionId ? 'v1 is still live' : 'v1 is live again',
        ),
      ).toBeVisible();
      expect(published).toBe(true);
      expect(
        await screen.findByRole('button', { name: 'No changes since v1' }),
      ).toHaveAttribute('aria-disabled', 'true');
    },
  );
});
