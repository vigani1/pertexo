import { describe, expect, it } from 'vitest';

import { encodeWorkflowInvocationKeyV2 } from '../src/invocation-key-v2.js';

describe('retained V2 invocation key bytes', () => {
  it('keeps the root key byte exact', () => {
    expect(
      encodeWorkflowInvocationKeyV2({
        workflowVersionId: 'v1',
        nodeId: 'node',
      }),
    ).toBe('v1|node|b:|i:');
  });

  it('keeps nested branch and iteration separators and escaping byte exact', () => {
    expect(
      encodeWorkflowInvocationKeyV2({
        workflowVersionId: 'ver sion',
        nodeId: 'node/a',
        branchPath: ['condition:true', 'switch:case/1'],
        iterationPath: [
          { loopNodeId: 'outer', ordinal: 0 },
          { loopNodeId: 'inner', ordinal: 12 },
        ],
      }),
    ).toBe(
      'ver%20sion|node%2Fa|b:condition%3Atrue%2Fswitch%3Acase%2F1|i:outer%3A0%2Finner%3A12',
    );
  });
});
