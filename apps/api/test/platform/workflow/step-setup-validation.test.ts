import type { WorkflowGraph } from '@pertexo/workflow-model';
import type * as NodeCatalog from '@pertexo/node-catalog';
import { describe, expect, it, vi } from 'vitest';

import { stepSetupIssues } from '../../../src/platform/workflow/step-setup.validation.js';

// A step whose lookup fails for a reason other than "not in the catalog".
const BROKEN_KEY = 'broken.lookup';

vi.mock('@pertexo/node-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCatalog>();
  return {
    ...actual,
    resolvePlatformNodeDefinition: (definition: { key?: unknown }) => {
      if (definition.key === BROKEN_KEY)
        throw new TypeError('catalog registration is corrupt');
      return actual.resolvePlatformNodeDefinition(definition);
    },
  };
});

function graphWith(key: string): WorkflowGraph {
  return {
    nodes: [
      {
        id: 'step',
        definition: { key, version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
    settings: {},
  };
}

describe('step setup issues for a step the catalog does not have', () => {
  it('leaves an unknown step to the compatibility check', () => {
    expect(stepSetupIssues(graphWith('future.node'))).toEqual([]);
  });

  it('leaves a step whose key is not even well formed to the compatibility check', () => {
    expect(stepSetupIssues(graphWith('Future-Node'))).toEqual([]);
  });

  it('lets any other lookup failure through instead of calling it unknown', () => {
    expect(() => stepSetupIssues(graphWith(BROKEN_KEY))).toThrow(
      'catalog registration is corrupt',
    );
  });
});
