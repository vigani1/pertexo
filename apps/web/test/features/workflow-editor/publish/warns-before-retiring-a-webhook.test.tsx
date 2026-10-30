import type { WorkflowGraphContract } from '@pertexo/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { findCanvas } from '../../../support/fixtures/editor-actions';
import { coldStart } from '../../../support/fixtures/run';
import {
  compatibility,
  editorHandlers,
  editorPath,
  etagA,
  manualDefinition,
  setDefinition,
  versionBody,
  versionId,
  workflowApi,
  workflowSummaryHandler,
} from '../../../support/fixtures/workflow-editor';
import { mockServer } from '../../../support/mock-server';
import { renderApp } from '../../../support/render-app';

const webhookDefinition = {
  ...manualDefinition,
  definition: { key: 'core.webhook', version: 1 },
};

const step = (id: string, key: string, label: string) => ({
  id,
  definition: { key, version: 1 },
  position: { x: 80, y: 80 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  label,
});

const live: WorkflowGraphContract = {
  nodes: [
    step('hook', 'core.webhook', 'Incoming order'),
    step('apply', 'core.set', 'Apply order'),
  ],
  edges: [],
  settings: {},
};

function renderPublish(draft: WorkflowGraphContract) {
  mockServer.use(
    ...editorHandlers(() => undefined, {
      graph: draft,
      definitions: [webhookDefinition, manualDefinition, setDefinition],
    }),
  );
  mockServer.use(
    workflowSummaryHandler('Order intake', versionId),
    http.get(`${workflowApi}/versions`, () =>
      HttpResponse.json({
        items: [versionBody(versionId, live)],
        nextCursor: null,
      }),
    ),
    http.get(`${workflowApi}/versions/${versionId}`, () =>
      HttpResponse.json(versionBody(versionId, live)),
    ),
    http.post(`${workflowApi}/validate`, () =>
      HttpResponse.json(
        {
          valid: true,
          issues: [],
          compatibility,
          currentPublication: {
            versionId,
            versionNumber: 1,
            matchesDraft: false,
          },
        },
        { headers: { etag: etagA } },
      ),
    ),
  );
  renderApp(editorPath);
}

async function openPublish() {
  const event = userEvent.setup();
  await findCanvas();
  await event.click(
    await screen.findByRole('button', { name: 'Publish v2' }, coldStart),
  );
  return screen.findByRole('dialog', { name: 'Publish v2' });
}

describe('publishing a workflow with a live webhook', () => {
  // product-ux-01: the dialog gives no warning that an endpoint stops answering.
  it.fails(
    'warns, by step name, when the publish removes a webhook step',
    async () => {
      renderPublish({
        nodes: [
          step('manual', 'core.manual', 'Start by hand'),
          step('apply', 'core.set', 'Apply order'),
        ],
        edges: [],
        settings: {},
      });
      const dialog = await openPublish();
      const mentions = await within(dialog).findAllByText(/Incoming order/u);
      expect(
        mentions.some(
          ({ textContent }) =>
            /stop|retire|no longer/iu.test(textContent) &&
            /address|endpoint|webhook/iu.test(textContent),
        ),
      ).toBe(true);
    },
  );

  it('does not warn when the webhook step stays', async () => {
    renderPublish({
      ...live,
      nodes: [
        step('hook', 'core.webhook', 'Incoming order'),
        { ...step('apply', 'core.set', 'Apply order'), config: { changed: 1 } },
      ],
    });
    const dialog = await openPublish();
    expect(
      (await within(dialog).findAllByText(/Incoming order/u)).length,
    ).toBeGreaterThan(0);
    expect(dialog).not.toHaveTextContent(/stops? answering|retire|no longer/iu);
  });
});
