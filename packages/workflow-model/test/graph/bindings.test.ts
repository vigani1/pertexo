import { describe, expect, it } from 'vitest';
import {
  addedWorkflowCallTargets,
  addedWorkflowConnectionReferences,
  connectionReferenceIds,
  workflowConnectionReferences,
  type WorkflowGraph,
} from '../../src/index.js';
import { node } from '../support/graph-contract.js';

const first = '00000000-0000-4000-8000-00000000000a';
const second = '00000000-0000-4000-8000-00000000000b';
const target = {
  workflowId: first,
  workflowVersionId: second,
  executableChecksum: `wf:sha256:${'a'.repeat(64)}`,
};
const graph = (nodes: WorkflowGraph['nodes']): WorkflowGraph => ({
  nodes,
  edges: [],
  settings: { maxRunDurationMs: 60_000 },
});
const call = (
  config: WorkflowGraph['nodes'][number]['config'] = { target },
) => ({
  ...node('call'),
  definition: { key: 'core.call', version: 1 },
  config,
  connectionRefs: {},
});

describe('authoring binding admission', () => {
  it('ignores incomplete draft calls and admits only added immutable bindings', () => {
    expect(addedWorkflowCallTargets(graph([call({})]))).toEqual([]);
    const current = graph([call()]);
    expect(addedWorkflowCallTargets(current)).toEqual([first]);
    expect(addedWorkflowCallTargets(current, current)).toEqual([]);
    expect(
      addedWorkflowCallTargets(
        graph([call({ target: { ...target, workflowVersionId: first } })]),
        current,
      ),
    ).toEqual([first]);
  });

  it('tracks nested paths and disabled ancestry while retaining unchanged connection bindings', () => {
    const leaf = { ...node('leaf'), connectionRefs: { primary: first } };
    const parent = {
      ...node('loop'),
      disabled: true,
      connectionRefs: {},
      structured: {
        kind: 'for_each' as const,
        maxIterations: 1,
        maxConcurrency: 1,
        body: {
          ...graph([leaf, call()]),
          inputPorts: ['item'],
          outputPorts: ['result'],
        },
      },
    };
    const current = graph([parent]);
    expect(workflowConnectionReferences(current)).toEqual([
      {
        id: first,
        path: '$.nodes.loop.structured.body.nodes.leaf.connectionRefs.primary',
        enabled: false,
      },
    ]);
    expect(addedWorkflowCallTargets(current)).toEqual([first]);
    expect(addedWorkflowConnectionReferences(current, current)).toEqual([]);
    const changed = graph([
      {
        ...parent,
        structured: {
          ...parent.structured,
          body: {
            ...parent.structured.body,
            nodes: [{ ...leaf, connectionRefs: { primary: second } }],
          },
        },
      },
    ]);
    expect(addedWorkflowConnectionReferences(changed, current)).toEqual([
      {
        id: second,
        path: '$.nodes.loop.structured.body.nodes.leaf.connectionRefs.primary',
        enabled: false,
      },
    ]);
  });

  it('deduplicates case variants and filters incomplete connection references before SQL', () => {
    expect(
      connectionReferenceIds([
        { id: first },
        { id: first.toUpperCase() },
        { id: 'draft-connection' },
      ]),
    ).toEqual([first]);
  });
});
