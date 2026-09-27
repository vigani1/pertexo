import { describe, expect, it } from 'vitest';

import { invocationKey } from '../src/scheduling.js';

describe('engine V2 invocation key compatibility', () => {
  it('agrees with persisted writer/checkpoint branch and iteration bytes', () => {
    expect(
      invocationKey({ workflowVersionId: 'version', nodeId: 'root' }),
    ).toBe('version|root|b:|i:');
    expect(
      invocationKey({
        workflowVersionId: 'version',
        nodeId: 'body',
        branchPath: ['condition:true'],
        iterationPath: [
          { loopNodeId: 'outer', ordinal: 0 },
          { loopNodeId: 'inner', ordinal: 12 },
        ],
      }),
    ).toBe('version|body|b:condition%3Atrue|i:outer%3A0%2Finner%3A12');
  });
});
