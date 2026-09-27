import { describe, expect, it } from 'vitest';

import { scopedInvocationKey } from '../src/execution/node-attempts/node-attempt-run-store-transactions.js';

describe('stored V2 invocation keys', () => {
  it('retains root, branch and nested iteration bytes used by checkpoints', () => {
    const workflowVersionId = 'version';
    expect(scopedInvocationKey({ workflowVersionId, nodeId: 'root' })).toBe(
      'version|root|b:|i:',
    );
    expect(
      scopedInvocationKey({
        workflowVersionId,
        nodeId: 'body',
        branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
        iterationPath: [
          { loopNodeId: 'outer', ordinal: 0 },
          { loopNodeId: 'inner', ordinal: 12 },
        ],
      }),
    ).toBe('version|body|b:condition%3Atrue|i:outer%3A0%2Finner%3A12');
  });
});
