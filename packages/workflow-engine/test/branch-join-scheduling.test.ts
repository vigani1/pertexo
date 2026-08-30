import { describe, expect, it } from 'vitest';

import {
  recordBranchDisposition,
  settleJoin,
  type BranchLedgerEntry,
  type JoinPolicy,
} from '../src/index.js';

describe('branch and join scheduling', () => {
  const ledger = (
    entries: readonly [string, BranchLedgerEntry['disposition']][],
  ) => entries.map(([branchId, disposition]) => ({ branchId, disposition }));
  const decide = (
    policy: JoinPolicy,
    entries: readonly [string, BranchLedgerEntry['disposition']][],
  ) => settleJoin({ joinId: 'join', policy, ledger: ledger(entries) });

  it('waits for explicit dispositions including skipped and missing branches', () => {
    expect(
      decide({ kind: 'any' }, [
        ['a', 'arrived'],
        ['b', 'pending'],
      ]),
    ).toEqual({ kind: 'waiting' });
  });

  it.each([
    [{ kind: 'all' } as const, ['a', 'b', 'c']],
    [{ kind: 'any' } as const, ['a']],
    [{ kind: 'count', count: 2 } as const, ['a', 'b']],
  ])('settles %j by canonical branch ID', (policy, selected) => {
    const result = decide(policy, [
      ['c', 'arrived'],
      ['b', 'arrived'],
      ['a', 'arrived'],
    ]);
    expect(result).toMatchObject({
      kind: 'satisfied',
      selectedBranchIds: selected,
    });
  });

  it('returns a typed unsatisfied result instead of waiting forever', () => {
    expect(
      decide({ kind: 'count', count: 2 }, [
        ['a', 'arrived'],
        ['b', 'missing'],
      ]),
    ).toMatchObject({
      kind: 'unsatisfied',
      reasonCode: 'insufficient_arrivals',
    });
  });

  it('lets all joins preserve explicit skipped and missing branches', () => {
    expect(
      decide({ kind: 'all' }, [
        ['a', 'arrived'],
        ['b', 'skipped'],
        ['c', 'missing'],
      ]),
    ).toMatchObject({ kind: 'satisfied', selectedBranchIds: ['a'] });
  });

  it('makes an exact duplicate branch fact idempotent and rejects conflicts', () => {
    const initial = ledger([
      ['b', 'pending'],
      ['a', 'pending'],
    ]);
    const arrived = recordBranchDisposition(initial, {
      branchId: 'a',
      disposition: 'arrived',
      output: {
        kind: 'artifact',
        artifactId: '00000000-0000-4000-8000-000000000101',
      },
    });
    const recorded = arrived.find(({ branchId }) => branchId === 'a');
    if (recorded === undefined) throw new Error('expected branch a');
    expect(recordBranchDisposition(arrived, recorded)).toEqual(arrived);
    expect(() =>
      recordBranchDisposition(arrived, {
        branchId: 'a',
        disposition: 'failed',
      }),
    ).toThrow(expect.objectContaining({ code: 'join_invalid' }));
  });
});
