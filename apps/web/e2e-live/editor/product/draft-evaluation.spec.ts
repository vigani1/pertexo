import { expect } from '@playwright/test';
import { test } from './account';
import { openModelProvider } from './model-provider';
import {
  checkRouting,
  connectAssistant,
  orderDraft,
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

test.describe('authoring evaluation with a real local model', () => {
  const modelName = process.env.PERTEXO_AUTHORING_EVAL_MODEL;
  const origin = process.env.PERTEXO_AUTHORING_EVAL_ORIGIN;
  test.skip(
    modelName === undefined && origin === undefined,
    'Set the local model origin and identifier to run the opt-in evaluation',
  );

  for (const { kind, description } of evaluationCases) {
    test(kind, async ({ page }, info) => {
      if (modelName === undefined || origin === undefined)
        throw new Error(
          'Set both PERTEXO_AUTHORING_EVAL_ORIGIN and PERTEXO_AUTHORING_EVAL_MODEL',
        );
      const inference = await openModelProvider({
        origin: new URL(origin),
        model: modelName,
      });
      try {
        const workspace = await openNewEditorWorkspace(
          page,
          `Draft evaluation ${kind}`,
        );
        await connectAssistant(page, workspace, modelName);
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
          modelName,
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
        const source = applied.nodes.find(
          ({ definition }) =>
            definition.key ===
            (kind === 'schedule' ? 'core.schedule' : 'core.manual'),
        );
        expect(source).toBeDefined();
        if (kind === 'schedule')
          expect(source?.config).toMatchObject({
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
            source: { nodeId: source?.id, port: 'out' },
            target: { nodeId: result?.id, port: 'in' },
          },
        ]);
        await publishSingleStep(page, path);
      } finally {
        await inference.close();
      }
    });
  }
});
