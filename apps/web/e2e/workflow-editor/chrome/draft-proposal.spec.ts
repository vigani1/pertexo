import { expect, test } from '../../support/fixtures';
import type { Page } from '@playwright/test';
import {
  draftProposalResultSchema,
  type DraftProposalResult,
} from '@pertexo/contracts';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { browserDefinitions } from '../../../test/support/fixtures/node-catalog';
import {
  addCsrfCookie,
  currentEtag,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspaceId,
} from '../support';
import { mappingGraph } from '../graph';

const initial = mappingGraph();
const target = {
  id: 'next',
  label: 'Next step',
  definition: { key: 'core.set', version: 1 },
  position: { x: 700, y: 80 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
};
const compatibility = {
  compatible: true,
  fingerprint: `wf-compat:sha256:${'0'.repeat(64)}`,
  issues: [],
};

test('reviews the removed and added link endpoints and the changed configuration version', async ({
  page,
  context,
}) => {
  await addCsrfCookie(context);
  const remote = remoteDraft(initial);
  await installEditorRoutes(page, remote);
  const base = {
    workflowId,
    revision: 1,
    graph: parseWorkflowGraphDraft(initial),
    compatibility,
    updatedAt: '2026-09-14T10:00:00.000Z',
  };
  const result = {
    kind: 'inspected',
    base,
    draft: {
      ...base,
      graph: {
        ...base.graph,
        nodes: [
          ...base.graph.nodes.map((node) =>
            node.id === 'target' ? { ...node, configVersion: 2 } : node,
          ),
          target,
        ],
        edges: [
          {
            id: 'manual-next',
            source: { nodeId: 'manual', port: 'out' },
            target: { nodeId: 'next', port: 'in' },
          },
        ],
      },
    },
    representationTag: currentEtag(remote),
    usage: { kind: 'complete', model: 'test', inputTokens: 1, outputTokens: 1 },
    validation: {
      valid: true,
      issues: [],
      compatibility,
      currentPublication: null,
    },
  } satisfies DraftProposalResult;
  await requestProposal(page, draftProposalResultSchema.parse(result));
  const review = page.getByRole('dialog', { name: 'Review proposed draft' });
  await expect(review).toContainText('Manual input (out) → Next step (in)');
  await expect(review).toContainText('Manual input (out) → Target (in)');
  await expect(review).toContainText('Target · Configuration version 1 → 2');
});

test('explains when the draft exceeds the model request budget', async ({
  page,
  context,
}) => {
  await addCsrfCookie(context);
  await installEditorRoutes(page, remoteDraft(initial));
  await requestProposal(page, { kind: 'request_too_large' });
  await expect(
    page.getByText('This draft is too large to send to the AI assistant.'),
  ).toBeVisible();
});

test('explains when the model runs out of output space', async ({
  page,
  context,
}) => {
  await addCsrfCookie(context);
  await installEditorRoutes(page, remoteDraft(initial));
  await requestProposal(page, { kind: 'output_truncated' });
  await expect(
    page.getByText(
      'The model ran out of output space before it finished. Try a shorter request or a model with more output.',
    ),
  ).toBeVisible();
});

test('shows field changes within the width of a phone', async ({
  page,
  context,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await addCsrfCookie(context);
  const seeded = {
    ...initial,
    nodes: parseWorkflowGraphDraft(initial).nodes.map((node) =>
      node.id === 'manual'
        ? {
            ...node,
            label: 'Schedule',
            definition: { key: 'core.schedule', version: 1 },
            config: { kind: 'interval', intervalMinutes: 15 },
          }
        : {
            ...node,
            label: 'Set status',
            inputMappings: { status: { kind: 'literal', value: 'waiting' } },
          },
    ),
  };
  const remote = remoteDraft(seeded);
  await installEditorRoutes(page, remote, {
    definitions: browserDefinitions(),
    workflowName: 'Order status',
  });
  const base = {
    workflowId,
    revision: 1,
    graph: parseWorkflowGraphDraft(seeded),
    compatibility,
    updatedAt: '2026-09-14T10:00:00.000Z',
  };
  await requestProposal(
    page,
    {
      kind: 'inspected',
      base,
      draft: {
        ...base,
        graph: {
          ...base.graph,
          nodes: base.graph.nodes.map((node) =>
            node.id === 'manual'
              ? { ...node, config: { ...node.config, intervalMinutes: 60 } }
              : {
                  ...node,
                  inputMappings: {
                    status: { kind: 'literal', value: 'ready' },
                  },
                },
          ),
        },
      },
      representationTag: currentEtag(remote),
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
    },
    'menu',
  );
  const review = page.getByRole('dialog', { name: 'Review proposed draft' });
  for (const text of [
    'intervalMinutes',
    '15',
    '60',
    'status',
    'waiting',
    'ready',
  ])
    await expect(review.getByText(text, { exact: true })).toBeVisible();
  expect(await review.evaluate((element) => element.scrollWidth)).toBe(
    await review.evaluate((element) => element.clientWidth),
  );
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      colorScheme,
    );
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath(`draft-settings-${colorScheme}.png`),
    });
  }
});

async function requestProposal(
  page: Page,
  result: DraftProposalResult,
  from: 'toolbar' | 'menu' = 'toolbar',
) {
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/proposal`,
    (route) =>
      route.fulfill({
        json:
          route.request().method() === 'GET'
            ? {
                kind: 'ready',
                connectionName: 'Test model',
                host: 'model.example.test',
                model: 'test',
                confirmation: 'confirmed',
              }
            : result,
      }),
  );
  await page.goto(editorUrl);
  if (from === 'menu')
    await page.getByRole('button', { name: 'More workflow actions' }).click();
  await page
    .getByRole(from === 'menu' ? 'menuitem' : 'button', {
      name: 'Ask assistant',
      exact: true,
    })
    .click();
  const request = page.getByRole('dialog', {
    name: 'Describe your workflow change',
  });
  await request
    .getByLabel('What should the workflow do?')
    .fill('Connect the next step.');
  await request.getByRole('button', { name: 'Send to model' }).click();
}
