import { describe, expect, it } from 'vitest';

import { selectRecoveryPrefix } from '../../src/server.js';
import { graph } from '../support/executable-workflow.js';
import {
  conditional,
  id,
  linear,
  record,
  source,
} from './recovery-workflow-fixtures.js';
import {
  bothBranches,
  compile,
  disabledCondition,
  disabledPrefix,
  patchCheckpoint,
  patchInvocation,
  patchRecord,
  reusedManual,
  withSource,
  type Fixture,
} from './evidence-fixtures.js';

const ARTIFACT = { kind: 'artifact', artifactId: id(700) } as const;

describe('recovery refuses a path whose earlier steps it cannot copy', () => {
  it.each<[string, () => Fixture, string]>([
    // The path from the trigger to the failed step.
    [
      'a trigger with no checkpoint entry or record',
      () =>
        withSource(linear(), (s) => ({
          ...s,
          nodes: s.nodes.filter((n) => n.nodeId !== 'manual'),
          checkpoint: {
            ...s.checkpoint,
            invocations: s.checkpoint.invocations.filter(
              (n) => n.nodeId !== 'manual',
            ),
          },
        })),
      'prefix_incomplete',
    ],
    [
      'a failed step that is disabled',
      () => {
        const fixture = linear();
        const base = graph();
        return {
          ...fixture,
          executable: compile({
            ...base,
            nodes: base.nodes.map((node) =>
              node.id === 'set' ? { ...node, disabled: true } : node,
            ),
          }),
        };
      },
      'evidence_unavailable',
    ],
    [
      'a Condition without its recorded choice',
      () => patchCheckpoint(conditional('true'), { branchSelections: [] }),
      'branch_evidence_unavailable',
    ],
    [
      'a choice recorded for another step',
      () => {
        const fixture = conditional('true');
        return patchCheckpoint(fixture, {
          branchSelections: fixture.source.checkpoint.branchSelections.map(
            (choice) => ({ ...choice, nodeId: 'manual' }),
          ),
        });
      },
      'branch_evidence_unavailable',
    ],
    [
      'a choice of a port a Condition does not have',
      () => {
        const fixture = conditional('true');
        return patchCheckpoint(fixture, {
          branchSelections: fixture.source.checkpoint.branchSelections.map(
            (choice) => ({ ...choice, selectedOutputPort: 'maybe' }),
          ),
        });
      },
      'branch_evidence_unavailable',
    ],
    [
      'a failed step off the branch the Condition chose',
      () =>
        bothBranches(
          'true',
          { nodeId: 'no-stop', port: 'false' },
          { nodeId: 'yes-stop', port: 'true' },
        ),
      'branch_evidence_unavailable',
    ],
    [
      'a later step marked skipped that nevertheless has a try',
      () => {
        const fixture = linear();
        const ran = record(fixture.executable, {
          nodeId: 'terminate',
          ordinal: 3,
          status: 'succeeded',
        });
        return withSource(fixture, (s) =>
          source([...s.nodes, { ...ran, status: 'skipped' }]),
        );
      },
      'suffix_already_executed',
    ],
    // Earlier steps whose values recovery would copy.
    ['a disabled Condition', disabledCondition, 'unsupported_graph'],
    [
      'a disabled step that was not skipped',
      () =>
        patchInvocation(
          patchRecord(disabledPrefix(), 'set', { status: 'canceled' }),
          'set',
          { status: 'canceled' },
        ),
      'branch_evidence_unavailable',
    ],
    [
      'a disabled step that has tries',
      () => {
        const fixture = disabledPrefix();
        const [attempt] = record(fixture.executable, {
          nodeId: 'set',
          ordinal: 4,
          status: 'succeeded',
        }).attempts;
        return patchRecord(fixture, 'set', {
          attempts: attempt === undefined ? [] : [attempt],
        });
      },
      'branch_evidence_unavailable',
    ],
    [
      'an earlier step without a recorded output',
      () => patchInvocation(linear(), 'manual', { output: undefined }),
      'prefix_incomplete',
    ],
    [
      'an earlier step whose output is a stored file',
      () => patchInvocation(linear(), 'manual', { output: ARTIFACT }),
      'artifact_value',
    ],
    [
      'an earlier step that never finished',
      () => patchRecord(linear(), 'manual', { completedAt: null }),
      'evidence_unavailable',
    ],
    [
      'an earlier step whose output came from another try',
      () =>
        patchInvocation(linear(), 'manual', {
          output: { kind: 'inline', attemptId: id(999) },
        }),
      'evidence_unavailable',
    ],
    [
      'an earlier step whose output was reused but is not marked reused',
      () =>
        patchInvocation(linear(), 'manual', {
          output: { kind: 'reused', nodeRunId: id(1) },
        }),
      'evidence_unavailable',
    ],
    [
      'an earlier step whose tries do not add up',
      () => patchRecord(linear(), 'manual', { currentAttemptId: id(999) }),
      'evidence_unavailable',
    ],
    // An earlier step reused from a previous recovery.
    [
      'a reused step that also has a try',
      () => reusedManual(linear(), { currentAttemptId: id(101) }),
      'evidence_unavailable',
    ],
    [
      'a reused step with a try number',
      () =>
        patchInvocation(
          reusedManual(linear(), { currentAttemptNumber: 1 }),
          'manual',
          { attemptNumber: 1 },
        ),
      'evidence_unavailable',
    ],
    [
      'a reused step with recorded tries',
      () => {
        const fixture = linear();
        const [attempt] = record(fixture.executable, {
          nodeId: 'manual',
          ordinal: 1,
          status: 'succeeded',
        }).attempts;
        return reusedManual(fixture, {
          attempts: attempt === undefined ? [] : [attempt],
        });
      },
      'evidence_unavailable',
    ],
    [
      'a reused step whose output is its own try',
      () =>
        patchInvocation(reusedManual(linear()), 'manual', {
          output: { kind: 'inline', attemptId: id(101) },
        }),
      'evidence_unavailable',
    ],
    [
      'a reused step whose output belongs to another step',
      () =>
        patchInvocation(reusedManual(linear()), 'manual', {
          output: { kind: 'reused', nodeRunId: id(999) },
        }),
      'evidence_unavailable',
    ],
  ])('%s', (_case, fixture, reason) => {
    expect(selectRecoveryPrefix(fixture())).toEqual({
      kind: 'refused',
      reason,
    });
  });
});
