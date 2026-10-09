import { HttpResponse, http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  addStepButton,
  draftBody,
  editorHandlers,
  editorPath,
  etagB,
  findCanvas,
  workflowApi,
  workspace,
  validHandler,
} from '../../support/fixtures/workflow-editor';
import { workflowDraftSaveRequestSchema } from '@pertexo/contracts';

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
  renderApp(editorPath);
  await findCanvas();
  const event = userEvent.setup();
  const duplicate = screen.getByRole('button', { name: 'Duplicate…' });
  expect(duplicate).toBeEnabled();
  await event.click(addStepButton(/Set fields/u));
  expect(duplicate).toBeDisabled();
  await waitFor(() => {
    expect(saved).toBe(true);
  });
  expect(duplicate).toBeDisabled();
  release?.();
  await waitFor(() => {
    expect(duplicate).toBeEnabled();
  });
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
  await event.click(addStepButton(/Set fields/u));
  await screen.findByRole('region', { name: 'Draft conflict' });
  expect(duplicate).toBeDisabled();
});
