import { describe, expect, it } from 'vitest';
import { workflowControlOutputNodeIdsV2 } from '@pertexo/workflow-model/graph';

import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
} from '../src/index.js';
import {
  conditionGraph,
  nestedForEachGraph,
  nodeRelease,
  pairedParallelGraph,
  switchGraph,
} from './executable-workflow.fixtures.js';

describe('persisted control-output selection', () => {
  it.each([
    {
      name: 'Condition',
      graph: conditionGraph('true'),
      release: nodeRelease({ condition: true }),
      expected: ['condition'],
    },
    {
      name: 'Switch',
      graph: switchGraph('case-01'),
      release: nodeRelease({ switch: true }),
      expected: ['switch'],
    },
    ...([1, 2, 3] as const).map((version) => ({
      name: `Parallel v${String(version)}`,
      graph: pairedParallelGraph(version),
      release: nodeRelease({
        parallel: true,
        merge: true,
        structuredVersion: version,
      }),
      expected: ['parallel'],
    })),
    {
      name: 'nested For Each',
      graph: nestedForEachGraph(),
      release: nodeRelease({ forEach: true }),
      expected: ['loop', 'body-first'],
    },
  ])(
    'finds $name nodes in the serialized compiled V2 envelope',
    ({ graph, release, expected }) => {
      const executable = buildWorkflowExecutableV2({
        graph,
        release: composeExecutableCompatibilityRelease(release),
      });
      const persisted = JSON.parse(
        JSON.stringify(executable.envelope),
      ) as unknown;
      expect(workflowControlOutputNodeIdsV2(persisted)).toEqual(
        new Set(expected),
      );
    },
  );
});
