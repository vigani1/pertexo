import { describe, expect, it } from 'vitest';
import type { WorkflowCheckpoint } from '../../../src/index.js';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  parseCheckpoint,
} from '../../../src/server.js';
import { checkpoint } from '../../support/advance-workflow.js';
import {
  pairedParallelGraph,
  nodeCatalog,
} from '../../support/executable-workflow.js';
import { startForEach } from '../../support/compilation/for-each.js';

describe('checkpoint seam', () => {
  it('fails closed on an invalid output reference', () => {
    expect(() =>
      parseCheckpoint({
        ...checkpoint(),
        invocations: [
          {
            invocationKey: 'done',
            nodeId: 'done',
            status: 'succeeded',
            attemptNumber: 1,
            output: { kind: 'inline', attemptId: 'not-a-uuid' },
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });
  it('rejects duplicate join invocation keys in an otherwise valid retained checkpoint', async () => {
    const valid = await selectedJoinCheckpoint();
    expect(parseCheckpoint(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
    const join = valid.joins[0];
    expect(join).toBeDefined();
    expect(() =>
      parseCheckpoint({ ...valid, joins: [...valid.joins, join] }),
    ).toThrow(
      expect.objectContaining({
        code: 'checkpoint_invalid',
        message: 'join invocation keys must be unique',
      }),
    );
  });
  it('rejects inconsistent persisted join selection after all branches are accounted for', async () => {
    const valid = await selectedJoinCheckpoint();
    expect(parseCheckpoint(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
    expect(valid.joins[0]).toMatchObject({
      policy: { kind: 'any' },
      selectedBranchIds: ['branch-01'],
      ledger: [
        { branchId: 'branch-01', disposition: 'arrived' },
        { branchId: 'branch-02', disposition: 'arrived' },
      ],
    });
    expect(() =>
      parseCheckpoint({
        ...valid,
        joins: valid.joins.map((join) => ({
          ...join,
          selectedBranchIds: ['branch-02'],
        })),
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'checkpoint_invalid',
        message: 'persisted join selection is inconsistent',
      }),
    );
  });
  it('rejects duplicate loop control keys in an otherwise valid retained checkpoint', async () => {
    const { declared } = await startForEach();
    const valid = parseCheckpoint(
      JSON.parse(JSON.stringify(declared.checkpoint)),
    );
    expect(valid).toEqual(declared.checkpoint);
    expect(valid.loops).toHaveLength(1);
    expect(() =>
      parseCheckpoint({ ...valid, loops: [...valid.loops, ...valid.loops] }),
    ).toThrow(
      expect.objectContaining({
        code: 'checkpoint_invalid',
        message: 'loop control invocation keys must be unique',
      }),
    );
  });
  it('rejects a loop cursor gap without changing any other checkpoint property', async () => {
    const { declared } = await startForEach();
    const valid = parseCheckpoint(
      JSON.parse(JSON.stringify(declared.checkpoint)),
    );
    expect(valid).toEqual(declared.checkpoint);
    expect(valid.loops[0]).toMatchObject({
      nextOrdinal: 1,
      completedPrefix: 0,
      activeOrdinals: [0],
      terminalOrdinals: [],
    });
    expect(() =>
      parseCheckpoint({
        ...valid,
        loops: valid.loops.map((loop) => ({ ...loop, nextOrdinal: 2 })),
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'checkpoint_invalid',
        message: 'loop cursor has an unrecorded ordinal',
      }),
    );
  });
  it('rejects oversized checkpoint collections before traversal', () => {
    const oversized = {
      ...checkpoint(),
      readySet: Array.from(
        { length: 10_001 },
        (_, index) => `node-${String(index)}`,
      ),
    };
    expect(() => parseCheckpoint(oversized)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
  });
  it('rejects non-JSON structure, unknown fields, and the byte-limit one-over', () => {
    expect(() =>
      parseCheckpoint({ ...checkpoint(), unexpected: true }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() =>
      parseCheckpoint(
        Object.assign(Object.create({ inherited: true }), checkpoint()),
      ),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() =>
      parseCheckpoint({ ...checkpoint(), invocations: sparse }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() =>
      parseCheckpoint({
        ...checkpoint(),
        readySet: ['x'.repeat(4 * 1_048_576)],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });
  it('admits only checkpoint identities and timestamps accepted by persistence', () => {
    expect(() =>
      createCheckpoint({
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));

    const waiting = {
      ...checkpoint(),
      runStatus: 'waiting',
      invocations: [
        {
          invocationKey: 'wait',
          nodeId: 'wait',
          status: 'waiting',
          attemptNumber: 1,
          resumeAt: '0',
          waitKind: 'node_wait',
        },
      ],
    };
    expect(() => parseCheckpoint(waiting)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );

    for (const resumeAt of [
      '2026-02-29T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-09-12T24:00:00Z',
      '2026-13-01T00:00:00Z',
    ])
      expect(() =>
        parseCheckpoint({
          ...waiting,
          invocations: [{ ...waiting.invocations[0], resumeAt }],
        }),
      ).toThrow(
        expect.objectContaining({
          code: 'checkpoint_invalid',
          message: 'resumeAt must be a canonical UTC timestamp',
        }),
      );
    for (const resumeAt of [
      '2024-02-29T00:00:00Z',
      '2026-09-12T10:00:00Z',
      '2026-09-12T10:00:00.000Z',
    ])
      expect(
        parseCheckpoint({
          ...waiting,
          invocations: [{ ...waiting.invocations[0], resumeAt }],
        }).invocations[0],
      ).toMatchObject({ resumeAt });
  });
  it('distinguishes traversal exits from cyclic checkpoint values', () => {
    const selfCycle: Record<string, unknown> = {};
    selfCycle.self = selfCycle;
    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = { first };
    first.second = second;
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);

    for (const cyclic of [selfCycle, first, cyclicArray])
      expect(() =>
        parseCheckpoint({ ...checkpoint(), unexpected: cyclic }),
      ).toThrow(
        expect.objectContaining({
          code: 'checkpoint_invalid',
          message: 'checkpoint must not contain cycles',
        }),
      );

    const sharedOutput = {
      kind: 'inline',
      attemptId: '00000000-0000-4000-8000-000000000101',
    } as const;
    expect(
      parseCheckpoint({
        ...checkpoint(),
        invocations: [
          {
            invocationKey: 'shared-a',
            nodeId: 'shared-a',
            status: 'succeeded',
            attemptNumber: 1,
            output: sharedOutput,
          },
          {
            invocationKey: 'shared-b',
            nodeId: 'shared-b',
            status: 'succeeded',
            attemptNumber: 1,
            output: sharedOutput,
          },
        ],
      }).invocations,
    ).toHaveLength(2);
  });
  it('accounts for escaped and surrogate-pair bytes in bounded identifiers', () => {
    const invocationKey = 'quoted"\n😀';
    const parsed = parseCheckpoint({
      ...checkpoint(),
      invocations: [
        {
          invocationKey,
          nodeId: 'node',
          status: 'succeeded',
          attemptNumber: 1,
        },
      ],
    });
    expect(parsed.invocations[0]?.invocationKey).toBe(invocationKey);
  });
});

/** Advance a real paired Parallel until its any-policy Merge has a persisted choice. */
async function selectedJoinCheckpoint(): Promise<WorkflowCheckpoint> {
  const graph = pairedParallelGraph();
  const merge = graph.nodes.find((node) => node.id === 'merge');
  if (merge === undefined) throw new Error('Missing Merge fixture');
  Object.assign(merge, {
    config: { ...merge.config, policy: { kind: 'any' } },
  });
  const base = {
    runId: 'retained-join',
    workflowVersionId: '00000000-0000-4000-8000-000000000001',
    executable: buildWorkflowExecutable({
      graph,
      catalog: composeExecutableCatalog(
        nodeCatalog({ parallel: true, merge: true }),
      ),
    }),
    occurredAt: '2026-08-24T10:00:00.000Z',
    maximumAdmissions: 200,
    signal: new AbortController().signal,
  };
  let plan = await advanceWorkflow({
    ...base,
    checkpoint: createCheckpoint({
      workflowVersionId: base.workflowVersionId,
      iterationBudget: 0,
    }),
    observations: [],
  });
  for (let turn = 0; turn < 10; turn += 1) {
    if (
      plan.checkpoint.joins.some((join) => join.selectedBranchIds !== undefined)
    )
      return plan.checkpoint;
    const completedOutputs = plan.attempts.map((attempt, index) => ({
      sequence: plan.checkpoint.nextEventSequence + index,
      attemptId: `00000000-0000-4000-8000-${String(plan.checkpoint.nextEventSequence + index).padStart(12, '0')}`,
      invocationKey: attempt.invocationKey,
      value:
        attempt.nodeId === 'parallel'
          ? { branchIds: ['branch-02', 'branch-01'] }
          : {},
    }));
    plan = await advanceWorkflow({
      ...base,
      checkpoint: JSON.parse(JSON.stringify(plan.checkpoint)),
      observations: completedOutputs.map((output) => ({
        kind: 'outcome' as const,
        sequence: output.sequence,
        occurredAt: base.occurredAt,
        invocationKey: output.invocationKey,
        attemptId: output.attemptId,
        attemptNumber: 1,
        status: 'succeeded' as const,
        output: { kind: 'inline' as const, attemptId: output.attemptId },
      })),
      completedOutputs,
    });
  }
  throw new Error('Merge did not reach a persisted selection');
}
