import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { findCanvas } from '../../support/fixtures/editor-actions';
import { oneStepGraph } from '../../support/fixtures/editor-graph';
import {
  compatibility,
  deferred,
  draftBody,
  editorHandlers,
  editorPath,
  etagA,
  workflowApi,
} from '../../support/fixtures/workflow-editor';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';

const proposalPath = `${workflowApi}/draft/proposal`;
const requestLabel = 'What should the workflow do?';

async function openAssistant() {
  await renderLoadedApp(editorPath);
  await findCanvas();
  const actor = userEvent.setup();
  const trigger = screen.getByRole('button', { name: 'Ask the assistant' });
  trigger.focus();
  await actor.keyboard('{Enter}');
  const panel = await screen.findByRole('complementary', { name: 'Assistant' });
  return { actor, trigger, panel };
}

function ready() {
  return HttpResponse.json({
    kind: 'ready',
    connectionName: 'Test model',
    host: 'model.example.test',
    model: 'test',
    confirmation: 'confirmed',
  });
}

it('moves focus into the assistant while it checks and into the request when ready', async () => {
  const disclosure = deferred<Response>();
  mockServer.use(
    ...editorHandlers(() => undefined),
    http.get(proposalPath, () => disclosure.promise),
  );
  const { panel, trigger } = await openAssistant();
  expect(panel).toHaveFocus();
  expect(trigger).not.toHaveAttribute('aria-expanded');
  disclosure.resolve(ready());
  expect(
    await screen.findByRole('textbox', { name: requestLabel }),
  ).toHaveFocus();
});

it('allows Enter to finish an IME composition before sending a complete request', async () => {
  const requests: unknown[] = [];
  mockServer.use(
    ...editorHandlers(() => undefined),
    http.get(proposalPath, ready),
    http.post(proposalPath, async ({ request }) => {
      requests.push(await request.json());
      return HttpResponse.json({ kind: 'output_truncated' });
    }),
  );
  const { actor } = await openAssistant();
  const request = await screen.findByRole('textbox', { name: requestLabel });
  fireEvent.change(request, { target: { value: '注文を確認' } });
  expect(fireEvent.keyDown(request, { key: 'Enter', isComposing: true })).toBe(
    true,
  );
  expect(requests).toEqual([]);
  await actor.click(request);
  await actor.keyboard('{Enter}');
  expect(
    await screen.findByText(/The model ran out of output space/u),
  ).toBeVisible();
  expect(requests).toEqual([
    { request: '注文を確認', confirmation: 'confirmed' },
  ]);
});

it('offers Regenerate after a draft conflict and prevents resubmitting the stale proposal', async () => {
  const base = draftBody(oneStepGraph, 1);
  mockServer.use(
    http.get(proposalPath, ready),
    http.post(proposalPath, () =>
      HttpResponse.json({
        kind: 'inspected',
        base,
        draft: base,
        representationTag: etagA,
        usage: {
          kind: 'complete',
          model: 'test',
          inputTokens: 1,
          outputTokens: 1,
        },
        validation: {
          valid: true,
          issues: [],
          compatibility,
          currentPublication: null,
        },
      }),
    ),
    http.put(`${workflowApi}/draft`, () =>
      HttpResponse.json(
        {
          type: 'urn:pertexo:problem:workflow.revision_conflict',
          title: 'Draft revision conflict',
          status: 409,
          code: 'workflow.revision_conflict',
          requestId: 'revision-conflict',
        },
        {
          status: 409,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    ),
    ...editorHandlers(() => undefined, { graph: oneStepGraph }),
  );
  const { actor } = await openAssistant();
  const request = await screen.findByRole('textbox', { name: requestLabel });
  await actor.type(request, 'Check the order');
  await actor.click(screen.getByRole('button', { name: 'Send to model' }));
  await actor.click(
    await screen.findByRole('button', { name: 'Apply to draft' }),
  );
  expect(await screen.findByText(/^The draft changed/u)).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Apply to draft' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Send to model' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Edit' }),
  ).not.toBeInTheDocument();
  await actor.click(screen.getByRole('button', { name: 'Regenerate' }));
  expect(
    await screen.findByRole('textbox', { name: requestLabel }),
  ).toHaveValue('Check the order');
});
