import { expect } from '@playwright/test';
import { test } from './account';
import { model, modelReply, openModelProvider } from './model-provider';
import {
  checkRouting,
  connectAssistant,
  orderDraft,
  requestProposal,
  reviewAndApply,
} from './draft-assistant';
import {
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
} from '../../support/authoring/single-step';
import { openNewEditorWorkspace } from '../../support/ordinary-editor-session';
import { saveGraph } from '../callable/fixture';

test.use({ accountGroup: 'evaluation' });

const graph = orderDraft;
const [manual, prepare] = graph.nodes;
const routingRequest =
  'I want to start this myself. If the incoming category is billing, put a priority of high in the result. For other categories do nothing.';

const evaluationCases = [
  {
    kind: 'create',
    description:
      'When I start this myself, put a status of ready in the result.',
  },
  { kind: 'route', description: routingRequest },
  {
    kind: 'rename',
    description:
      'Could you call the Prepare order step Normalize order instead?',
  },
  {
    kind: 'schedule',
    description:
      'Every 15 minutes, produce a result with status set to waiting.',
  },
] as const;

const sentinel = 'evaluation-header-sentinel';
const header = { 'X-Partner-Reference': sentinel };
const status = (value: string) => ({
  ...prepare,
  inputMappings: { status: { kind: 'literal' as const, value } },
});
const schedule = (intervalMinutes: number) => ({
  ...manual,
  definition: { key: 'core.schedule', version: 1 },
  label: 'Schedule',
  config: { kind: 'interval', intervalMinutes },
});
// The settings the editor saves for a new HTTP request step.
const requestDefaults = {
  timeoutMillis: 10_000,
  maxRedirects: 3,
  maxResponseBytes: 1_048_576,
  inlineResponseBytes: 65_536,
};
const request = (url: string, headers: Record<string, string>) => ({
  ...prepare,
  definition: { key: 'http.request', version: 1 },
  label: 'Fetch orders',
  config: { method: 'GET', url, headers, ...requestDefaults },
});
const initialUrl = 'https://api.example.test/orders';
const changedUrl = 'https://api.example.test/v2/orders';
const headerDraft = {
  ...graph,
  nodes: [manual, request(initialUrl, header)],
};
const edits = [
  {
    kind: 'edit-schedule',
    description: 'Run this every hour instead.',
    seeded: { ...graph, nodes: [schedule(15), status('waiting')] },
    expected: { ...graph, nodes: [schedule(60), status('waiting')] },
    reply: {
      draft: { ...graph, nodes: [schedule(60), status('waiting')] },
    },
  },
  {
    kind: 'edit-value',
    description: 'Make the status done instead of ready.',
    seeded: { ...graph, nodes: [manual, status('ready')] },
    expected: { ...graph, nodes: [manual, status('done')] },
    reply: { draft: { ...graph, nodes: [manual, status('done')] } },
  },
  {
    kind: 'edit-url-keeps-secret',
    description:
      'Point the request at https://api.example.test/v2/orders instead.',
    seeded: headerDraft,
    expected: {
      ...graph,
      nodes: [manual, request(changedUrl, header)],
    },
    reply: {
      draft: {
        ...graph,
        nodes: [manual, request(changedUrl, { kind: 'existing_setting' })],
      },
    },
  },
  {
    kind: 'refuse-secret-change',
    description: 'Change the X-Partner-Reference header to new-token.',
    seeded: headerDraft,
    expected: headerDraft,
    reply: { maskedSetting: true },
  },
] as const;

test.describe('authoring evaluation with a real local model', () => {
  const modelName = process.env.PERTEXO_AUTHORING_EVAL_MODEL;
  const origin = process.env.PERTEXO_AUTHORING_EVAL_ORIGIN;
  const scripted = process.env.PERTEXO_AUTHORING_EVAL_SCRIPTED === 'true';
  test.skip(
    !scripted && modelName === undefined && origin === undefined,
    'Set the local model origin and identifier to run the opt-in evaluation',
  );

  for (const { kind, description } of evaluationCases) {
    test(kind, async ({ page }, info) => {
      test.skip(
        scripted,
        'These cases are already covered by the real-model evaluation.',
      );
      const source = localModel(origin, modelName);
      const inference = await openModelProvider(source);
      try {
        const workspace = await openNewEditorWorkspace(
          page,
          `Draft evaluation ${kind}`,
        );
        await connectAssistant(page, workspace, source.model);
        const path = await createEditorWorkflow(
          page,
          workspace,
          `Evaluate ${kind}`,
        );
        const seeded = {
          ...graph,
          nodes: [
            manual,
            {
              ...prepare,
              inputMappings: {
                reference: { kind: 'literal', value: 'keep-order-reference' },
              },
            },
          ],
        };
        if (kind === 'rename') {
          await saveGraph(page, path, seeded);
          await page.reload();
        }
        await reviewAndApply(page, {
          description,
          inference,
          info,
          path,
          modelName: source.model,
        });
        if (kind === 'route') {
          await checkRouting(page, workspace, path);
          return;
        }
        const { graph: applied } = await readEditorDraft(page, path);
        if (kind === 'rename') {
          expect(applied).toEqual({
            ...seeded,
            nodes: [
              seeded.nodes[0],
              { ...seeded.nodes[1], label: 'Normalize order' },
            ],
          });
          return;
        }
        const trigger = applied.nodes.find(
          ({ definition }) =>
            definition.key ===
            (kind === 'schedule' ? 'core.schedule' : 'core.manual'),
        );
        expect(trigger).toBeDefined();
        if (kind === 'schedule')
          expect(trigger?.config).toMatchObject({
            kind: 'interval',
            intervalMinutes: 15,
          });
        const result = applied.nodes.find(
          ({ definition }) => definition.key === 'core.set',
        );
        expect(result?.inputMappings.status).toMatchObject({
          kind: 'literal',
          value: kind === 'schedule' ? 'waiting' : 'ready',
        });
        expect(applied.edges).toMatchObject([
          {
            source: { nodeId: trigger?.id, port: 'out' },
            target: { nodeId: result?.id, port: 'in' },
          },
        ]);
        await publishSingleStep(page, path);
      } finally {
        await inference.close();
      }
    });
  }

  for (const { kind, description, seeded, expected, reply } of edits) {
    test(kind, async ({ page }, info) => {
      const source = scripted ? undefined : localModel(origin, modelName);
      const modelId = source?.model ?? model;
      const inference = await openModelProvider(source ?? [modelReply(reply)]);
      try {
        const workspace = await openNewEditorWorkspace(
          page,
          `Draft evaluation ${kind}`,
        );
        await connectAssistant(page, workspace, modelId);
        const path = await createEditorWorkflow(
          page,
          workspace,
          `Evaluate ${kind}`,
        );
        await saveGraph(page, path, seeded);
        await page.reload();
        const options = {
          description,
          inference,
          info,
          path,
          modelName: modelId,
        };
        if (kind === 'refuse-secret-change') {
          const result = await requestProposal(page, options);
          expect(result.kind).toBe('rejected');
          const review = page.getByRole('complementary', { name: 'Assistant' });
          await expect(review).toContainText(/protected setting/iu);
          await expect(
            review.getByRole('button', { name: 'Apply to draft' }),
          ).toHaveCount(0);
        } else {
          await reviewAndApply(page, options);
        }
        const { graph: applied } = await readEditorDraft(page, path);
        expect(applied).toEqual(expected);
        expect(JSON.stringify(applied)).not.toContain('new-token');
        expect(inference.calls.length).toBeGreaterThan(0);
        // The request the user typed is theirs to send; saved values are not.
        expect(JSON.stringify(inference.calls)).not.toContain(sentinel);
      } finally {
        await inference.close();
      }
    });
  }
});

function localModel(origin: string | undefined, modelName: string | undefined) {
  if (modelName === undefined || origin === undefined)
    throw new Error(
      'Set both PERTEXO_AUTHORING_EVAL_ORIGIN and PERTEXO_AUTHORING_EVAL_MODEL',
    );
  return { origin: new URL(origin), model: modelName };
}
