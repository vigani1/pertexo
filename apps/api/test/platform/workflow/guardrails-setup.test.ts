import type { WorkflowGraph } from '@pertexo/workflow-model';
import { expect, it } from 'vitest';
import { prepareNodeValidation } from '../../../src/node-testing/prepare-node-validation.js';
import { stepSetupIssues } from '../../../src/platform/workflow/step-setup.validation.js';

it.each([
  { modelReview: false, connected: false },
  { modelReview: true, connected: false },
  { modelReview: true, connected: true },
])(
  'validates Guardrails for publication and Test step with model review $modelReview and connection $connected',
  async ({ modelReview, connected }) => {
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
          connectionRefs: connected
            ? { model_api_key: '742c59fe-3d20-4c3e-a0d2-0919c6785ad0' }
            : {},
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
    if (modelReview && !connected) {
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
    } else {
      expect(publishIssues).toEqual([]);
      expect(preview.issues).toEqual([]);
    }
    if (modelReview)
      expect(preview).toHaveProperty(
        'disclosure.mayCauseExternalSideEffect',
        true,
      );
  },
);
