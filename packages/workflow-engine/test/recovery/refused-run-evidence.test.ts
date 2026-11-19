import { describe, expect, it } from 'vitest';

import { selectRecoveryPrefix } from '../../src/server.js';
import { graph } from '../support/executable-workflow.js';
import {
  id,
  linear,
  record,
  source,
  versionId,
} from './recovery-workflow-fixtures.js';
import {
  compile,
  failedSet,
  patchCheckpoint,
  patchInvocation,
  patchRecord,
  withSource,
  type Fixture,
} from './evidence-fixtures.js';

describe('recovery refuses a run whose evidence does not hold together', () => {
  it.each<[string, () => Fixture, string]>([
    // The run as a whole.
    [
      'a run that has not finished',
      () => withSource(linear(), (s) => ({ ...s, completedAt: null })),
      'evidence_unavailable',
    ],
    [
      'a checkpoint of another version',
      () => withSource(linear(), (s) => ({ ...s, workflowVersionId: id(201) })),
      'evidence_unavailable',
    ],
    [
      'a checkpoint whose run did not fail',
      () => patchCheckpoint(linear(), { runStatus: 'running' }),
      'evidence_unavailable',
    ],
    [
      'a run someone canceled',
      () => patchCheckpoint(linear(), { cancelRequested: true }),
      'evidence_unavailable',
    ],
    [
      'a run that ran out of time',
      () => patchCheckpoint(linear(), { deadlineExpired: true }),
      'evidence_unavailable',
    ],
    [
      'a run that waited at a join',
      () =>
        patchCheckpoint(linear(), {
          joins: [
            {
              joinInvocationKey: 'join',
              joinId: 'join',
              policy: { kind: 'all' },
              ledger: [],
            },
          ],
        }),
      'evidence_unavailable',
    ],
    [
      'a run that looped',
      () =>
        patchCheckpoint(linear(), {
          loops: [
            {
              loopId: 'loop',
              controlInvocationKey: 'loop-control',
              branchPath: [],
              iterationPath: [],
              bodyRootNodeIds: ['body'],
              bodySinkNodeId: 'body',
              collection: { kind: 'inline', attemptId: id(101) },
              collectionChecksum: 'sum',
              collectionSize: 1,
              maxConcurrency: 1,
              maxIterations: 1,
              nextOrdinal: 1,
              activeOrdinals: [],
              completedPrefix: 0,
              terminalOrdinals: [0],
            },
          ],
        }),
      'evidence_unavailable',
    ],
    // The step records against the checkpoint.
    [
      'two records for one step',
      () =>
        withSource(linear(), (s) => ({
          ...s,
          nodes: [...s.nodes, ...s.nodes.filter((n) => n.nodeId === 'manual')],
        })),
      'evidence_unavailable',
    ],
    [
      'two checkpoint entries for one step',
      () =>
        withSource(linear(), (s) => ({
          ...s,
          checkpoint: {
            ...s.checkpoint,
            invocations: [
              ...s.checkpoint.invocations,
              ...s.checkpoint.invocations.filter((n) => n.nodeId === 'manual'),
            ],
          },
        })),
      'evidence_unavailable',
    ],
    [
      'a step that ran but lost its record',
      () =>
        withSource(linear(), (s) => ({
          ...s,
          nodes: s.nodes.filter((n) => n.nodeId !== 'manual'),
        })),
      'evidence_unavailable',
    ],
    [
      'a record with another side-effect class',
      () => patchRecord(linear(), 'manual', { sideEffectClass: 'unsafe' }),
      'evidence_unavailable',
    ],
    [
      'a record of another invocation',
      () => patchRecord(linear(), 'manual', { invocationKey: 'elsewhere' }),
      'evidence_unavailable',
    ],
    [
      'a checkpoint status the record disagrees with',
      () => patchInvocation(linear(), 'manual', { status: 'running' }),
      'evidence_unavailable',
    ],
    [
      'a checkpoint attempt the record disagrees with',
      () => patchInvocation(linear(), 'manual', { attemptNumber: 2 }),
      'evidence_unavailable',
    ],
    [
      'a record in a branch the checkpoint does not show',
      () =>
        patchRecord(linear(), 'manual', {
          branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
        }),
      'evidence_unavailable',
    ],
    [
      'a record inside a loop iteration',
      () =>
        patchRecord(linear(), 'manual', {
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        }),
      'evidence_unavailable',
    ],
    // The failed step.
    [
      'two failed steps',
      () => {
        const fixture = linear();
        const manual = record(fixture.executable, {
          nodeId: 'manual',
          ordinal: 1,
          status: 'failed',
        });
        return withSource(fixture, (s) =>
          source(s.nodes.map((n) => (n.nodeId === 'manual' ? manual : n))),
        );
      },
      'multiple_failures',
    ],
    [
      'a failed step without its tries',
      () =>
        patchRecord(linear(), 'set', {
          attempts: [],
          currentAttemptId: null,
          currentAttemptNumber: null,
        }),
      'evidence_unavailable',
    ],
    [
      'a failed step whose last try has no error kind',
      () => {
        const fixture = linear();
        return patchRecord(fixture, 'set', {
          attempts: failedSet(fixture).attempts.map((a) => ({
            ...a,
            errorKind: null,
          })),
        });
      },
      'evidence_unavailable',
    ],
    [
      'a failed step the run does not record as its failure',
      () =>
        withSource(linear(), (s) => ({
          ...s,
          status: 'outcome_unknown',
          checkpoint: { ...s.checkpoint, runStatus: 'outcome_unknown' },
        })),
      'evidence_unavailable',
    ],
    [
      'a last try that was meant to be retried',
      () => {
        const fixture = linear();
        return patchRecord(fixture, 'set', {
          attempts: failedSet(fixture).attempts.map((a) => ({
            ...a,
            retryDecision: 'retry',
          })),
        });
      },
      'evidence_unavailable',
    ],
    [
      'a failed step that never finished',
      () => patchRecord(linear(), 'set', { completedAt: null }),
      'evidence_unavailable',
    ],
    [
      'a last try the retry setting would have retried',
      () => {
        const fixture = linear();
        return patchRecord(fixture, 'set', {
          attempts: failedSet(fixture).attempts.map((a) => ({
            ...a,
            failureKind: 'retry',
            errorKind: 'network',
          })),
        });
      },
      'evidence_unavailable',
    ],
    [
      'an earlier try whose result is unknown',
      () => {
        const fixture = linear();
        return patchRecord(fixture, 'set', {
          attempts: failedSet(fixture).attempts.map((a) => ({
            ...a,
            status: 'outcome_unknown',
          })),
        });
      },
      'unknown_effect',
    ],
    [
      'a try marked for retry the retry setting would not retry',
      () => {
        const fixture = linear();
        const [last] = failedSet(fixture).attempts;
        if (last === undefined) throw new Error('Recovery attempt is missing');
        return patchRecord(fixture, 'set', {
          attempts: [
            { ...last, id: id(601), retryDecision: 'retry' },
            { ...last, id: id(602), number: 2 },
          ],
          currentAttemptId: id(602),
          currentAttemptNumber: 2,
        });
      },
      'evidence_unavailable',
    ],
  ])('%s', (_case, fixture, reason) => {
    expect(selectRecoveryPrefix(fixture())).toEqual({
      kind: 'refused',
      reason,
    });
  });

  it('a graph with a failure link', () => {
    const base = graph();
    const executable = compile({
      ...base,
      nodes: [
        ...base.nodes,
        { ...base.nodes[1], id: 'handler' },
        { ...base.nodes[2], id: 'handler-stop', inputMappings: {} },
      ],
      edges: [
        ...base.edges,
        {
          id: 'failure',
          source: { nodeId: 'set', port: '__failure' },
          target: { nodeId: 'handler', port: 'in' },
        },
        {
          id: 'handler-stop',
          source: { nodeId: 'handler', port: 'out' },
          target: { nodeId: 'handler-stop', port: 'in' },
        },
      ],
    });
    expect(
      selectRecoveryPrefix({ executable, source: linear().source }),
    ).toEqual({ kind: 'refused', reason: 'unsupported_graph' });
  });
});

describe('recovery rejects input it cannot trust', () => {
  it('an executable this process did not verify', () => {
    const { executable, source: retained } = linear();
    expect(() =>
      selectRecoveryPrefix({
        executable: {
          envelope: executable.envelope,
          checksum: executable.checksum,
        },
        source: retained,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('a checkpoint naming a step the executable does not have', () => {
    const fixture = linear();
    expect(() =>
      selectRecoveryPrefix(
        patchCheckpoint(fixture, {
          invocations: [
            ...fixture.source.checkpoint.invocations,
            {
              invocationKey: `${versionId}|stranger|b:|i:`,
              nodeId: 'stranger',
              status: 'skipped',
              attemptNumber: 0,
            },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'workflow_identity_invalid' }));
  });
});
