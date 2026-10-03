import type { PublishedWorkflowV3Projection } from '@pertexo/database/execution';
import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityReleaseV3,
  createCheckpoint,
  createWorkflowCheckpointV3,
  invocationKey,
} from '@pertexo/workflow-engine';
import { describe, expect, it } from 'vitest';
import { createCoordinatorAdvanceEngine } from '../src/execution/coordinator-engine.js';
import {
  RUN_ID,
  VERSION_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  graph,
} from './support/execution-engine.fixture.js';

const release = composeExecutableCompatibilityReleaseV3(CORE_REGISTRY_RELEASE);
const executable = buildWorkflowExecutableV3({
  graph: {
    ...graph(),
    schemaVersion: 2,
    callable: {
      schemaVersion: 1,
      input: { type: 'object', properties: {}, required: [] },
      result: { type: 'object', properties: {}, required: [] },
      resultSelector: { kind: 'literal', value: {} },
    },
  },
  release,
});
const projection: PublishedWorkflowV3Projection = {
  id: VERSION_ID,
  workspaceId: WORKSPACE_ID,
  workflowId: WORKFLOW_ID,
  versionNumber: 1,
  schemaVersion: 2,
  executableSchemaVersion: 3,
  executableJson: executable.envelope,
  checksum: executable.checksum,
  compatibilityReleaseEpoch: release.epoch,
};
const checkpointInput = {
  engineVersion: 'phase3-engine-v1',
  workflowVersionId: VERSION_ID,
  iterationBudget: 0,
};
const input = {
  runId: RUN_ID,
  workflowVersionId: VERSION_ID,
  projection,
  checkpoint: createWorkflowCheckpointV3(checkpointInput),
  observations: [],
  occurredAt: '2026-10-02T00:00:00.000Z',
  maximumAdmissions: 1,
  signal: new AbortController().signal,
};

describe('native coordinator executable/checkpoint boundary', () => {
  it('returns a typed value-work stop instead of a transition or no-change', async () => {
    const demandExecutable = buildWorkflowExecutableV3({
      graph: {
        schemaVersion: 2,
        settings: {},
        nodes: [graph().nodes[0]],
        edges: [],
        callable: {
          schemaVersion: 1,
          input: { type: 'object', properties: {}, required: [] },
          result: { type: 'object', properties: {}, required: [] },
          resultSelector: { kind: 'run_input', path: '$' },
        },
      },
      release,
    });
    const manualKey = invocationKey({
      workflowVersionId: VERSION_ID,
      nodeId: 'manual',
    });
    const current = {
      ...createWorkflowCheckpointV3(checkpointInput),
      runStatus: 'running',
      admittedInvocationKeys: [manualKey],
      invocations: [
        {
          invocationKey: manualKey,
          nodeId: 'manual',
          attemptNumber: 1,
          status: 'running',
        },
      ],
    };
    const stop = {
      kind: 'unavailable' as const,
      reason: 'control_read_failed' as const,
    };
    await expect(
      createCoordinatorAdvanceEngine({ admissionRelease: release }).advance({
        ...input,
        checkpoint: current,
        projection: {
          ...projection,
          executableJson: demandExecutable.envelope,
          checksum: demandExecutable.checksum,
        },
        observations: [
          {
            kind: 'outcome',
            sequence: current.nextEventSequence,
            occurredAt: input.occurredAt,
            invocationKey: manualKey,
            attemptId: RUN_ID,
            attemptNumber: 1,
            status: 'succeeded',
            output: { kind: 'inline', attemptId: RUN_ID },
          },
        ],
        loadCallableCompletion: () =>
          Promise.resolve({ kind: 'stopped', stop }),
      }),
    ).resolves.toEqual({ kind: 'value_work_stopped', stop });
  });
  it('advances the authenticated V3 artifact and retains its checkpoint format', async () => {
    const engine = createCoordinatorAdvanceEngine({
      admissionRelease: release,
    });
    const result = await engine.advance(input);
    expect(result).toMatchObject({
      kind: 'transition',
      plan: {
        checkpoint: {
          schemaVersion: 3,
          calls: [],
          workflowVersionId: VERSION_ID,
        },
        attempts: [expect.objectContaining({ nodeId: 'manual' })],
      },
    });
    if (result.kind !== 'transition') throw new Error('Missing transition');
    await expect(
      engine.advance({ ...input, checkpoint: result.plan.checkpoint }),
    ).resolves.toEqual({ kind: 'no_change', revision: 1 });
  });

  it('rejects a retained checkpoint paired with V3 instead of upgrading it', async () => {
    const engine = createCoordinatorAdvanceEngine({
      admissionRelease: release,
    });
    await expect(
      engine.advance({
        ...input,
        checkpoint: createCheckpoint(checkpointInput),
      }),
    ).rejects.toThrow('checkpoint format');
  });

  it('rejects a tampered V3 artifact instead of falling back to retained execution', async () => {
    const engine = createCoordinatorAdvanceEngine({
      admissionRelease: release,
    });
    await expect(
      engine.advance({
        ...input,
        projection: {
          ...projection,
          checksum: `wf:v3:sha256:${'f'.repeat(64)}`,
        },
      }),
    ).rejects.toThrow();
  });
});
