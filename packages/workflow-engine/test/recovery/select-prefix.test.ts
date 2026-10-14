import { describe, expect, it } from 'vitest';
import { selectRecoveryPrefix } from '../../src/recovery/select-prefix.js';
import type { RecoveryNode } from '../../src/recovery/contract.js';
import { conditional, id, linear, record, source } from './fixtures.js';

function changeTarget(
  change: (node: RecoveryNode) => RecoveryNode,
  unsafe = false,
) {
  const fixture = linear(unsafe);
  return {
    ...fixture,
    source: source(
      fixture.source.nodes.map((node) =>
        node.nodeId === 'set' ? change(node) : node,
      ),
    ),
  };
}

describe('recovery prefix selection', () => {
  it('selects only completed earlier steps and leaves the failed step for execution', () => {
    const result = selectRecoveryPrefix(linear());
    expect(result.kind).toBe('candidate');
    if (result.kind !== 'candidate') throw new Error('Expected candidate');
    expect(result.prefix.map((node) => node.source.nodeId)).toEqual(['manual']);
    expect(result.target.nodeId).toBe('set');
    expect(result.effectRisk).toBe('ordinary');
  });

  it.each(['true', 'false'] as const)(
    'freezes the recorded %s branch before a failed leaf Stop run',
    (port) => {
      const result = selectRecoveryPrefix(conditional(port));
      expect(result.kind).toBe('candidate');
      if (result.kind !== 'candidate') throw new Error('Expected candidate');
      expect(result.prefix.map((node) => node.source.nodeId)).toEqual([
        'manual',
        'condition',
      ]);
      expect(result.target.nodeId).toBe('terminate');
      expect(result.branchSelections).toMatchObject([
        { selectedOutputPort: port },
      ]);
    },
  );

  it('retries a failed Condition with no frozen choice for that decision', () => {
    const fixture = conditional('true');
    const retained = source([
      record(fixture.executable, 'manual', 1, 'succeeded'),
      record(fixture.executable, 'condition', 2, 'failed'),
    ]);
    expect(
      selectRecoveryPrefix({ ...fixture, source: retained }),
    ).toMatchObject({
      kind: 'candidate',
      target: { nodeId: 'condition' },
      prefix: [{ source: { nodeId: 'manual' } }],
      branchSelections: [],
    });
  });
  it('refuses checkpoint successes whose physical evidence has disappeared', () => {
    const fixture = linear();
    const retained = source([
      ...fixture.source.nodes,
      record(fixture.executable, 'terminate', 3, 'succeeded'),
    ]);
    expect(
      selectRecoveryPrefix({
        ...fixture,
        source: { ...retained, nodes: fixture.source.nodes },
      }),
    ).toEqual({ kind: 'refused', reason: 'evidence_unavailable' });
  });

  it('requires person acknowledgement when an unsafe definite failure reached the service', () => {
    const fixture = changeTarget(
      (node) => ({
        ...node,
        attempts: node.attempts.map((attempt) => ({
          ...attempt,
          possiblyDispatched: true,
        })),
      }),
      true,
    );
    expect(selectRecoveryPrefix(fixture)).toMatchObject({
      kind: 'candidate',
      effectRisk: 'possible_effects',
    });
  });

  it('treats a dispatch marker conservatively even when the returned failure says no dispatch', () => {
    const fixture = changeTarget(
      (node) => ({
        ...node,
        attempts: node.attempts.map((attempt) => ({
          ...attempt,
          dispatchMarked: true,
        })),
      }),
      true,
    );
    expect(selectRecoveryPrefix(fixture)).toMatchObject({
      kind: 'candidate',
      effectRisk: 'possible_effects',
    });
  });

  it('offers a verified unknown target under the stronger risk and refuses incomplete evidence', () => {
    const fixture = changeTarget(
      (node) => ({
        ...node,
        status: 'outcome_unknown',
        attempts: node.attempts.map((attempt) => ({
          ...attempt,
          failureKind: 'outcome_unknown',
          errorKind: 'network',
          possiblyDispatched: true,
          dispatchMarked: true,
          retryDecision: 'outcome_unknown',
        })),
      }),
      true,
    );
    const retained = {
      ...fixture.source,
      status: 'outcome_unknown' as const,
      checkpoint: {
        ...fixture.source.checkpoint,
        runStatus: 'outcome_unknown' as const,
      },
    };
    expect(
      selectRecoveryPrefix({ ...fixture, source: retained }),
    ).toMatchObject({
      kind: 'candidate',
      effectRisk: 'unknown_outcome',
      target: { nodeId: 'set' },
      prefix: [{ source: { nodeId: 'manual' } }],
    });
    expect(
      selectRecoveryPrefix({
        ...fixture,
        source: {
          ...retained,
          nodes: retained.nodes.map((node) =>
            node.nodeId !== 'set'
              ? node
              : {
                  ...node,
                  attempts: node.attempts.map((attempt) => ({
                    ...attempt,
                    possiblyDispatched: null,
                  })),
                },
          ),
        },
      }),
    ).toEqual({ kind: 'refused', reason: 'evidence_unavailable' });
  });

  it('refuses an unknown executor outcome even if run history was marked failed', () => {
    const fixture = changeTarget(
      (node) => ({
        ...node,
        attempts: node.attempts.map((attempt) => ({
          ...attempt,
          failureKind: 'outcome_unknown',
          possiblyDispatched: true,
        })),
      }),
      true,
    );
    expect(selectRecoveryPrefix(fixture)).toEqual({
      kind: 'refused',
      reason: 'unknown_effect',
    });
  });

  it('uses existing retry safety to refuse ambiguous unsafe retry evidence', () => {
    const fixture = changeTarget(
      (node) => ({
        ...node,
        attempts: node.attempts.map((attempt) => ({
          ...attempt,
          failureKind: 'retry',
          errorKind: 'network',
          possiblyDispatched: true,
        })),
      }),
      true,
    );
    expect(selectRecoveryPrefix(fixture)).toEqual({
      kind: 'refused',
      reason: 'unknown_effect',
    });
  });

  it('refuses absent dispatch classification and a foreign attempt pointer', () => {
    expect(
      selectRecoveryPrefix(
        changeTarget((node) => ({
          ...node,
          attempts: node.attempts.map((attempt) => ({
            ...attempt,
            possiblyDispatched: null,
          })),
        })),
      ),
    ).toEqual({ kind: 'refused', reason: 'evidence_unavailable' });
    expect(
      selectRecoveryPrefix(
        changeTarget((node) => ({ ...node, currentAttemptId: id(999) })),
      ),
    ).toEqual({ kind: 'refused', reason: 'evidence_unavailable' });
  });

  it('refuses already executed suffixes', () => {
    const fixture = linear();
    const retained = source([
      ...fixture.source.nodes,
      record(fixture.executable, 'terminate', 3, 'succeeded'),
    ]);
    expect(selectRecoveryPrefix({ ...fixture, source: retained })).toEqual({
      kind: 'refused',
      reason: 'suffix_already_executed',
    });
  });

  it('accepts a previously reused owned prefix without manufacturing an attempt', () => {
    const fixture = linear();
    const retained = source(
      fixture.source.nodes.map((node) =>
        node.nodeId !== 'manual'
          ? node
          : {
              ...node,
              currentAttemptId: null,
              currentAttemptNumber: null,
              completedAt: null,
              attempts: [],
              reused: {
                sourceRunId: id(500),
                sourceNodeRunId: id(501),
                completedAt: '2026-10-01T00:00:00.000Z',
              },
            },
      ),
    );
    expect(
      selectRecoveryPrefix({ ...fixture, source: retained }),
    ).toMatchObject({
      kind: 'candidate',
      prefix: [{ source: { attempts: [] } }],
    });
  });

  it('does not recover canceled or successful source runs', () => {
    const fixture = linear();
    for (const status of ['canceled', 'succeeded'] as const)
      expect(
        selectRecoveryPrefix({
          ...fixture,
          source: { ...fixture.source, status },
        }),
      ).toEqual({ kind: 'refused', reason: 'source_not_failed' });
  });
});
