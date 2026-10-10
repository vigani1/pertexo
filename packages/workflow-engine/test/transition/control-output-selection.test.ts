import { describe, expect, it } from 'vitest';
import { workflowControlOutputNodeIds } from '@pertexo/workflow-model';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '../../src/index.js';
import {
  conditionGraph,
  nestedForEachGraph,
  nodeCatalog,
  pairedParallelGraph,
  switchGraph,
} from '../support/executable-workflow.js';

describe('persisted control-output selection', () => {
  it.each([
    {
      name: 'Condition',
      graph: conditionGraph('true'),
      catalog: nodeCatalog({ condition: true }),
      expected: ['condition'],
    },
    {
      name: 'Switch',
      graph: switchGraph('case-01'),
      catalog: nodeCatalog({ switch: true }),
      expected: ['switch'],
    },
    {
      name: 'Parallel',
      graph: pairedParallelGraph(),
      catalog: nodeCatalog({ parallel: true, merge: true }),
      expected: ['parallel'],
    },
    {
      name: 'nested For Each',
      graph: nestedForEachGraph(),
      catalog: nodeCatalog({ forEach: true }),
      expected: ['loop', 'body-first'],
    },
  ])(
    'finds $name nodes in the serialized compiled envelope',
    ({ graph, catalog, expected }) => {
      const executable = buildWorkflowExecutable({
        graph,
        catalog: composeExecutableCatalog(catalog),
      });
      const persisted = JSON.parse(
        JSON.stringify(executable.envelope),
      ) as unknown;
      expect(workflowControlOutputNodeIds(persisted)).toEqual(
        new Set(expected),
      );
    },
  );
});
