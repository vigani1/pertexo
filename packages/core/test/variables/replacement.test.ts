import { describe, expect, it } from 'vitest';
import { planWorkspaceVariableReplacement } from '../../src/variables/replacement.js';

const current = {
  values: { A: 1, B: true },
  descriptions: { A: 'Number', B: 'Flag' },
};

describe('workspace variable replacement', () => {
  it.each([
    [
      'retains descriptions only for retained names when metadata is omitted',
      current,
      { values: { A: 1 } },
      { descriptions: { A: 'Number' }, changedNames: ['B'] },
    ],
    [
      'treats explicit undefined metadata as omitted',
      current,
      { values: current.values, descriptions: undefined },
      { descriptions: current.descriptions, changedNames: [] },
    ],
    [
      'clears descriptions when an explicit empty map is supplied',
      current,
      { values: current.values, descriptions: {} },
      { descriptions: {}, changedNames: ['A', 'B'] },
    ],
    [
      'discards empty descriptions and descriptions for absent names',
      current,
      { values: { A: 1 }, descriptions: { A: '', GONE: 'Removed' } },
      { descriptions: {}, changedNames: ['A', 'B'] },
    ],
    [
      'sorts added, removed, value-changed and description-changed names once',
      current,
      { values: { C: 'new', A: 2 }, descriptions: { A: 'Replaced' } },
      { descriptions: { A: 'Replaced' }, changedNames: ['A', 'B', 'C'] },
    ],
    [
      'keeps an identical replacement a no-op',
      current,
      current,
      { descriptions: current.descriptions, changedNames: [] },
    ],
    [
      'preserves exact scalar comparison semantics',
      { values: { ZERO: -0 }, descriptions: {} },
      { values: { ZERO: 0 } },
      { descriptions: {}, changedNames: ['ZERO'] },
    ],
  ])('%s', (_case, before, replacement, expected) => {
    expect(planWorkspaceVariableReplacement(before, replacement)).toEqual(
      expected,
    );
  });
});
