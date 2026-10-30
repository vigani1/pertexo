import { describe, expect, it } from 'vitest';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  verifyWorkflowExecutable,
} from '../../../src/index.js';
import { computeWorkflowExecutableChecksum } from '../../../src/compilation/identity.js';
import type { WorkflowExecutable } from '../../../src/compilation/foundation.js';
import { nodeCatalog, switchGraph } from '../../support/executable-workflow.js';

const catalog = composeExecutableCatalog(nodeCatalog({ switch: true }));

// Publication doesn't check every step's setup against its schema, so a stored
// version may hold one that a new compilation refuses. It must keep verifying:
// refusing it here would stop its runs, rather than failing only that step.
describe('a published version whose control setup a new compile refuses', () => {
  it('keeps verifying against the served catalog', () => {
    const compiled = buildWorkflowExecutable({
      graph: switchGraph('case-01'),
      catalog,
    });
    const envelope = structuredClone(compiled.envelope) as WorkflowExecutable;
    const stored = {
      ...envelope,
      graph: {
        ...envelope.graph,
        nodes: withRefusedCase(envelope.graph.nodes),
      },
    };

    expect(() =>
      buildWorkflowExecutable({
        graph: {
          ...switchGraph('case-01'),
          nodes: withRefusedCase(switchGraph('case-01').nodes),
        },
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    expect(() =>
      verifyWorkflowExecutable({
        envelope: stored,
        checksum: computeWorkflowExecutableChecksum(stored),
        catalog,
      }),
    ).not.toThrow();
  });
});

function withRefusedCase<Node extends Readonly<{ id: string }>>(
  nodes: readonly Node[],
): readonly Node[] {
  return nodes.map((node) =>
    node.id === 'switch'
      ? { ...node, config: { cases: [{ id: 'other', equals: 1 }] } }
      : node,
  );
}
