import { describe, expect, it } from 'vitest';

import { selectRecoveryPrefix } from '../../src/server.js';
import { graph } from '../support/executable-workflow.js';
import { id, linear, record, source } from './recovery-workflow-fixtures.js';
import {
  bothBranches,
  compile,
  disabledPrefix,
  failedSet,
  patchCheckpoint,
  patchRecord,
} from './evidence-fixtures.js';

describe('recovery accepts', () => {
  it('a disabled earlier step that was skipped, without copying it', () => {
    expect(selectRecoveryPrefix(disabledPrefix())).toMatchObject({
      kind: 'candidate',
      target: { nodeId: 'terminate' },
      prefix: [{ source: { nodeId: 'manual' } }],
    });
  });

  it('a later step the failure skipped, which has no record', () => {
    const fixture = linear();
    const checkpoint = fixture.source.checkpoint;
    expect(
      selectRecoveryPrefix(
        patchCheckpoint(fixture, {
          invocations: [
            ...checkpoint.invocations,
            {
              invocationKey: record(fixture.executable, {
                nodeId: 'terminate',
                ordinal: 3,
                status: 'succeeded',
              }).invocationKey,
              nodeId: 'terminate',
              status: 'skipped',
              attemptNumber: 0,
            },
          ],
        }),
      ),
    ).toMatchObject({ kind: 'candidate', target: { nodeId: 'set' } });
  });

  it.each(['true', 'false'] as const)(
    'the branch the Condition chose (%s) when both branches have a step',
    (port) => {
      const stop = port === 'true' ? 'yes-stop' : 'no-stop';
      expect(
        selectRecoveryPrefix(bothBranches(port, { nodeId: stop, port })),
      ).toMatchObject({ kind: 'candidate', target: { nodeId: stop } });
    },
  );

  it('a safe step that may have reached the service, as an ordinary retry', () => {
    const fixture = linear();
    expect(
      selectRecoveryPrefix(
        patchRecord(fixture, 'set', {
          attempts: failedSet(fixture).attempts.map((attempt) => ({
            ...attempt,
            possiblyDispatched: true,
            dispatchMarked: true,
          })),
        }),
      ),
    ).toMatchObject({ kind: 'candidate', effectRisk: 'ordinary' });
  });

  it('an unsafe step whose earlier try reached the service but whose last did not, as a possible effect', () => {
    const original = graph();
    const executable = compile(
      {
        ...original,
        nodes: original.nodes.map((node) =>
          node.id === 'set'
            ? { ...node, retry: { maximumAttempts: 2, delayMillis: 1_000 } }
            : node,
        ),
      },
      { setRetryClass: 'unsafe' },
    );
    const target = record(executable, {
      nodeId: 'set',
      ordinal: 2,
      status: 'failed',
    });
    const [last] = target.attempts;
    if (last === undefined) throw new Error('Recovery attempt is missing');
    const attempts = [
      {
        ...last,
        id: id(601),
        number: 1,
        failureKind: 'retry' as const,
        errorKind: 'rate_limit' as const,
        dispatchMarked: true,
        retryDecision: 'retry',
      },
      { ...last, id: id(602), number: 2 },
    ];
    const retained = source([
      record(executable, { nodeId: 'manual', ordinal: 1, status: 'succeeded' }),
      {
        ...target,
        attempts,
        currentAttemptId: id(602),
        currentAttemptNumber: 2,
      },
    ]);
    expect(
      selectRecoveryPrefix({ executable, source: retained }),
    ).toMatchObject({ kind: 'candidate', effectRisk: 'possible_effects' });
  });
});
