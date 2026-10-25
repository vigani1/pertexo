import { describe, expect, it } from 'vitest';
import { planWorkspaceVariableReplacement } from '../../src/values/variables/replacement.js';

describe('workspace variable replacement', () => {
  const current = {
    values: { A: 1, B: true },
    descriptions: { A: 'Number', B: 'Flag' },
  };
  it('retains descriptions only for retained names when metadata is omitted', () => {
    expect(
      planWorkspaceVariableReplacement(current, { values: { A: 1 } }),
    ).toEqual({ descriptions: { A: 'Number' }, changedNames: ['B'] });
  });
  it('treats explicit undefined metadata as omitted', () => {
    expect(
      planWorkspaceVariableReplacement(current, {
        values: current.values,
        descriptions: undefined,
      }),
    ).toEqual({ descriptions: current.descriptions, changedNames: [] });
  });
  it('clears descriptions when an explicit empty map is supplied', () => {
    expect(
      planWorkspaceVariableReplacement(current, {
        values: current.values,
        descriptions: {},
      }),
    ).toEqual({ descriptions: {}, changedNames: ['A', 'B'] });
  });
  it('discards empty descriptions and descriptions for absent names', () => {
    expect(
      planWorkspaceVariableReplacement(current, {
        values: { A: 1 },
        descriptions: { A: '', GONE: 'Removed' },
      }),
    ).toEqual({ descriptions: {}, changedNames: ['A', 'B'] });
  });
  it('sorts added, removed, value-changed and description-changed names once', () => {
    expect(
      planWorkspaceVariableReplacement(current, {
        values: { C: 'new', A: 2 },
        descriptions: { A: 'Replaced' },
      }).changedNames,
    ).toEqual(['A', 'B', 'C']);
  });
  it('keeps an identical replacement a no-op', () => {
    expect(planWorkspaceVariableReplacement(current, current)).toEqual({
      descriptions: current.descriptions,
      changedNames: [],
    });
  });
  it('preserves exact scalar comparison semantics', () => {
    expect(
      planWorkspaceVariableReplacement(
        { values: { ZERO: -0 }, descriptions: {} },
        { values: { ZERO: 0 } },
      ).changedNames,
    ).toEqual(['ZERO']);
  });
});
