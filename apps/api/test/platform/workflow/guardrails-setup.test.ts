import type { WorkflowGraph } from '@pertexo/workflow-model';
import { expect, it } from 'vitest';
import { prepareNodeValidation } from '../../../src/node-testing/prepare-node-validation.js';
import { stepSetupIssues } from '../../../src/platform/workflow/step-setup.validation.js';

it.each([false, true])(
  'requires a Guardrails connection in publication and Test step only with model review=%s',
  async (modelReview) => {
    const graph: WorkflowGraph = {
      nodes: [
        {
          id: 'guardrails',
          definition: { key: 'ai.guardrails', version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config: {
            checks: modelReview
              ? [{ kind: 'model', mode: 'injection', model: 'fake' }]
              : [{ kind: 'pii' }],
          },
          inputMappings: { text: { kind: 'literal', value: 'sample' } },
          connectionRefs: {},
        },
      ],
      edges: [],
      settings: {},
    };
    const publishIssues = stepSetupIssues(graph);
    const preview = await prepareNodeValidation({
      graph,
      nodeId: 'guardrails',
    });
    if (modelReview) {
      expect(publishIssues).toContainEqual(
        expect.objectContaining({
          path: '$.nodes.guardrails.connectionRefs.model_api_key',
        }),
      );
      expect(preview.issues).toContainEqual(
        expect.objectContaining({
          code: 'node.connection_required',
          path: '$.connectionRefs.model_api_key',
        }),
      );
      expect(preview).toHaveProperty(
        'disclosure.mayCauseExternalSideEffect',
        true,
      );
    } else {
      expect(publishIssues).toEqual([]);
      expect(preview.issues).toEqual([]);
    }
  },
);
