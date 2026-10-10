import { describe, expect, it } from 'vitest';

import { invocationKey } from '../../../src/transition/scheduling/loops.js';

describe('invocation keys', () => {
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

  it('escapes separators inside identifiers and paths', () => {
    expect(
      invocationKey({
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
