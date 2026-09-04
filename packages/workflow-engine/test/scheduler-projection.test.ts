import { describe, expect, it } from 'vitest';

import { projectSchedulerState } from '../src/operations.js';
import type { WorkflowExecutableGraphV2 } from '../src/executable-workflow.js';

describe('scheduler executable projection', () => {
  it('visits each nested structured body once', () => {
    let bodyReads = 0;
    let graph: WorkflowExecutableGraphV2 & {
      readonly inputPorts: readonly string[];
      readonly outputPorts: readonly string[];
    } = {
      settings: {},
      nodes: [],
      edges: [],
      inputPorts: [],
      outputPorts: [],
    };
    for (let depth = 0; depth < 12; depth += 1) {
      const body = graph;
      const structured = {
        kind: 'for_each' as const,
        maxIterations: 1,
        maxConcurrency: 1,
        get body() {
          bodyReads += 1;
          return body;
        },
      };
      graph = {
        settings: {},
        edges: [],
        inputPorts: [],
        outputPorts: [],
        nodes: [
          {
            id: `loop-${String(depth)}`,
            definition: { key: 'core.for-each', version: 1 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
            disabled: false,
            sideEffectClass: 'safe',
            executor: { key: 'core.for-each', version: 1 },
            executorAbi: 1,
            policyReferences: [],
            structured,
          },
        ],
      };
    }

    const projected = projectSchedulerState(graph);

    expect(bodyReads).toBe(12);
    expect(projected.structuredBodies).toHaveLength(12);
  });
});
