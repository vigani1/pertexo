import { describe, expect, it } from 'vitest';

import {
  branchPathHasPrefix,
  sameBranchPath,
  sameIterationPath,
} from '../src/scope.js';

describe('structured scope identity', () => {
  it('compares branch scope exactly and by prefix', () => {
    const prefix = [{ nodeId: '並列:α', outputPort: 'a/b' }];
    const nested = [...prefix, { nodeId: 'nested', outputPort: 'x:y' }];
    expect(sameBranchPath(prefix, [...prefix])).toBe(true);
    expect(sameBranchPath(prefix, nested)).toBe(false);
    expect(branchPathHasPrefix(nested, prefix)).toBe(true);
    expect(branchPathHasPrefix(prefix, nested)).toBe(false);
  });

  it('compares loop identity without serialized delimiter assumptions', () => {
    const path = [
      { loopNodeId: 'loop:1', ordinal: 2 },
      { loopNodeId: '循环/二', ordinal: 0 },
    ];
    const firstPart = path[0];
    expect(firstPart).toBeDefined();
    if (firstPart === undefined)
      throw new Error('fixture is missing first part');
    expect(sameIterationPath(path, structuredClone(path))).toBe(true);
    expect(
      sameIterationPath(path, [
        firstPart,
        { loopNodeId: '循环/二', ordinal: 1 },
      ]),
    ).toBe(false);
    expect(sameIterationPath(undefined, [])).toBe(true);
  });
});
