import { workflowDraftSaveRequestSchema } from '@pertexo/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import {
  addStepButton,
  openStepList,
  openWorkflowMenu,
  findCanvas,
} from '../../support/fixtures/editor-actions';
import {
  draftBody,
  editorHandlers,
  editorPath,
  etagB,
  validHandler,
  workflowApi,
  workspace,
} from '../../support/fixtures/workflow-editor';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';

it('blocks saved-draft duplication while local edits are dirty/saving and after a save conflict', async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saved = false;
  mockServer.use(
    ...editorHandlers(() => undefined, {
      capabilities: [...workspace.capabilities, 'workflow:create'],
    }),
    validHandler(),
  );
  mockServer.use(
    http.put(`${workflowApi}/draft`, async ({ request }) => {
      saved = true;
      const body = workflowDraftSaveRequestSchema.parse(await request.json());
      await held;
      return HttpResponse.json(draftBody(body.graph, 2), {
        headers: { etag: etagB },
      });
    }),
  );
  await renderLoadedApp(editorPath);
  await findCanvas();
  const event = userEvent.setup();
  async function duplicateIs(enabled: boolean) {
    const menu = await openWorkflowMenu(event);
    const duplicate = menu.getByRole('menuitem', { name: 'Duplicate…' });
    if (enabled) expect(duplicate).not.toHaveAttribute('aria-disabled', 'true');
    else expect(duplicate).toHaveAttribute('aria-disabled', 'true');
    await event.keyboard('{Escape}');
  }
  await duplicateIs(true);
  await openStepList(event);
  await event.click(addStepButton(/Set fields/u));
  await duplicateIs(false);
  await waitFor(() => {
    expect(saved).toBe(true);
  });
  await duplicateIs(false);
  release?.();
  await screen.findByText(/^Saved/u);
  await duplicateIs(true);
  mockServer.use(
    http.put(`${workflowApi}/draft`, () =>
      HttpResponse.json(
        {
          type: 'urn:pertexo:problem:workflow.revision_conflict',
          title: 'Changed',
          status: 412,
          code: 'workflow.revision_conflict',
          requestId: 'request-conflict',
          currentRevision: 3,
          currentEtag: etagB,
        },
        {
          status: 412,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    ),
  );
  await openStepList(event);
  await event.click(addStepButton(/Set fields/u));
  await screen.findByRole('region', { name: 'Draft conflict' });
  await duplicateIs(false);
});
