import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '../../../src/index.js';
import {
  forEachGraph,
  nodeCatalog,
} from '../../support/executable-workflow.js';
import { startForEach } from '../../support/compilation/for-each.js';

describe('For Each production operations', () => {
  it('settles concurrent completions independent of observation order', async () => {
    const { afterManual, base, control } = await startForEach();

    const concurrentGraph = structuredClone(forEachGraph());
    const concurrentControl = concurrentGraph.nodes.find(
      ({ id }) => id === 'loop',
    );
    if (concurrentControl === undefined || !('structured' in concurrentControl))
      throw new Error('For Each structure missing');
    Object.assign(concurrentControl.structured, { maxConcurrency: 2 });
    const concurrentExecutable = buildWorkflowExecutable({
      graph: concurrentGraph,
      catalog: composeExecutableCatalog(
        nodeCatalog({ forEach: true, setRetryClass: 'idempotent-with-key' }),
      ),
    });
    const concurrent = await advanceWorkflow({
      ...base,
      executable: concurrentExecutable,
      checkpoint: afterManual.checkpoint,
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'outcome',
          sequence: afterManual.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: control.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000113',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000113',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: afterManual.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000113',
          invocationKey: control.invocationKey,
          value: { items: ['first', 'second'], iterationCount: 2 },
        },
      ],
    });
    expect(concurrent.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [0, 1],
      nextOrdinal: 2,
    });
    expect(
      concurrent.attempts.map(({ iterationPath }) => iterationPath),
    ).toEqual([
      [{ loopNodeId: 'loop', ordinal: 0 }],
      [{ loopNodeId: 'loop', ordinal: 1 }],
    ]);
    const concurrentRoots = new Map(
      concurrent.attempts.map((attempt) => [
        attempt.iterationPath?.at(-1)?.ordinal,
        attempt,
      ]),
    );
    const firstConcurrentFailure = await advanceWorkflow({
      ...base,
      executable: concurrentExecutable,
      checkpoint: concurrent.checkpoint,
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: base.occurredAt,
          invocationKey: concurrentRoots.get(1)?.invocationKey ?? '',
          attemptId: '00000000-0000-4000-8000-000000000118',
          attemptNumber: 1,
          failureKind: 'failed',
          errorKind: 'provider',
          possiblyDispatched: false,
          safeErrorCode: 'body.first-failure',
        },
      ],
      completedOutputs: [],
    });
    expect(firstConcurrentFailure.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [0],
      terminalOrdinals: [1],
      terminalStatus: 'failed',
    });
    const secondConcurrentFailure = await advanceWorkflow({
      ...base,
      executable: concurrentExecutable,
      checkpoint: firstConcurrentFailure.checkpoint,
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: base.occurredAt,
          invocationKey: concurrentRoots.get(0)?.invocationKey ?? '',
          attemptId: '00000000-0000-4000-8000-000000000119',
          attemptNumber: 1,
          failureKind: 'failed',
          errorKind: 'provider',
          possiblyDispatched: false,
          safeErrorCode: 'body.later-failure',
        },
      ],
      completedOutputs: [],
    });
    expect(secondConcurrentFailure.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [],
      completedPrefix: 2,
      terminalOrdinals: [],
      terminalStatus: 'failed',
    });
    expect(
      secondConcurrentFailure.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === control.invocationKey,
      ),
    ).toMatchObject({ status: 'failed' });
    const completeConcurrent = async (order: readonly number[]) => {
      const roots = new Map(
        concurrent.attempts.map((attempt) => [
          attempt.iterationPath?.at(-1)?.ordinal,
          attempt,
        ]),
      );
      const rootObservations = order.map((ordinal, index) => {
        const attempt = roots.get(ordinal);
        if (attempt === undefined) throw new Error('concurrent root missing');
        const attemptId = `00000000-0000-4000-8000-000000000${ordinal === 0 ? '114' : '115'}`;
        return {
          kind: 'outcome' as const,
          sequence: concurrent.checkpoint.nextEventSequence + index,
          occurredAt: base.occurredAt,
          invocationKey: attempt.invocationKey,
          attemptId,
          attemptNumber: 1,
          status: 'succeeded' as const,
          output: { kind: 'inline' as const, attemptId },
        };
      });
      const rootsCompleted = await advanceWorkflow({
        ...base,
        executable: concurrentExecutable,
        checkpoint: concurrent.checkpoint,
        maximumAdmissions: 10,
        observations: rootObservations,
        completedOutputs: rootObservations.map((observation) => ({
          sequence: observation.sequence,
          attemptId: observation.attemptId,
          invocationKey: observation.invocationKey,
          value: {},
        })),
      });
      const sinks = new Map(
        rootsCompleted.attempts.map((attempt) => [
          attempt.iterationPath?.at(-1)?.ordinal,
          attempt,
        ]),
      );
      const sinkObservations = order.map((ordinal, index) => {
        const attempt = sinks.get(ordinal);
        if (attempt === undefined) throw new Error('concurrent sink missing');
        const attemptId = `00000000-0000-4000-8000-000000000${ordinal === 0 ? '116' : '117'}`;
        return {
          kind: 'outcome' as const,
          sequence: rootsCompleted.checkpoint.nextEventSequence + index,
          occurredAt: base.occurredAt,
          invocationKey: attempt.invocationKey,
          attemptId,
          attemptNumber: 1,
          status: 'succeeded' as const,
          output: { kind: 'inline' as const, attemptId },
        };
      });
      return advanceWorkflow({
        ...base,
        executable: concurrentExecutable,
        checkpoint: rootsCompleted.checkpoint,
        maximumAdmissions: 10,
        observations: sinkObservations,
        completedOutputs: sinkObservations.map((observation) => ({
          sequence: observation.sequence,
          attemptId: observation.attemptId,
          invocationKey: observation.invocationKey,
          value: {},
        })),
      });
    };
    const forwardCompletion = await completeConcurrent([0, 1]);
    const reverseCompletion = await completeConcurrent([1, 0]);
    expect(reverseCompletion.checkpoint.loops).toEqual(
      forwardCompletion.checkpoint.loops,
    );
    expect(reverseCompletion.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [],
      completedPrefix: 2,
      terminalOrdinals: [],
    });
  });
});
