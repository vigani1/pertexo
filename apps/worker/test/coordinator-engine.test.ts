import {
  CORE_REGISTRY_RELEASE,
  CORE_REGISTRY_RELEASE_SUCCESSOR,
  CORE_REGISTRY_RELEASE_SUPPORT,
} from '@pertexo/nodes-core';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
  createExecutableCompatibilityReleaseSupport,
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

describe('coordinator advance engine', () => {
  it('verifies the persisted projection before advancing the exact executable', async () => {
    const release = composeExecutableCompatibilityRelease(
      CORE_REGISTRY_RELEASE,
    );
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const checkpoint = createCheckpoint({
      engineVersion: 'phase3-engine-v1',
      workflowVersionId: VERSION_ID,
      iterationBudget: 0,
      nextEventSequence: 2,
    });
    const engine = createCoordinatorAdvanceEngine({
      admissionRelease: release,
      currentRelease: release,
    });

    const result = await engine.advance({
      runId: RUN_ID,
      workflowVersionId: VERSION_ID,
      projection: {
        id: VERSION_ID,
        workspaceId: WORKSPACE_ID,
        workflowId: WORKFLOW_ID,
        versionNumber: 1,
        schemaVersion: 1,
        checksum: executable.checksum,
        executableSchemaVersion: 2,
        executableJson: executable.envelope,
        compatibilityReleaseEpoch: release.epoch,
      },
      checkpoint,
      observations: [],
      occurredAt: '2026-08-21T00:00:00.000Z',
      maximumAdmissions: 1,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      kind: 'transition',
      plan: {
        attempts: [
          expect.objectContaining({
            nodeId: 'manual',
            sideEffectClass: 'safe',
          }),
        ],
        checkpoint: { workflowVersionId: VERSION_ID },
      },
    });

    if (result.kind !== 'transition')
      throw new Error('fixture did not produce its initial transition');
    await expect(
      engine.advance({
        runId: RUN_ID,
        workflowVersionId: VERSION_ID,
        projection: {
          id: VERSION_ID,
          workspaceId: WORKSPACE_ID,
          workflowId: WORKFLOW_ID,
          versionNumber: 1,
          schemaVersion: 1,
          checksum: executable.checksum,
          executableSchemaVersion: 2,
          executableJson: executable.envelope,
          compatibilityReleaseEpoch: release.epoch,
        },
        checkpoint: result.plan.checkpoint,
        observations: [],
        occurredAt: '2026-08-21T00:00:01.000Z',
        maximumAdmissions: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'no_change', revision: 1 });
  });

  it('rejects a projection column that disagrees with immutable envelope provenance', async () => {
    const release = composeExecutableCompatibilityRelease(
      CORE_REGISTRY_RELEASE,
    );
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const engine = createCoordinatorAdvanceEngine({
      admissionRelease: release,
      currentRelease: release,
    });

    await expect(
      engine.advance({
        runId: RUN_ID,
        workflowVersionId: VERSION_ID,
        projection: {
          id: VERSION_ID,
          workspaceId: WORKSPACE_ID,
          workflowId: WORKFLOW_ID,
          versionNumber: 1,
          schemaVersion: 1,
          checksum: executable.checksum,
          executableSchemaVersion: 2,
          executableJson: executable.envelope,
          compatibilityReleaseEpoch: release.epoch + 1,
        },
        checkpoint: createCheckpoint({
          engineVersion: 'phase3-engine-v1',
          workflowVersionId: VERSION_ID,
          iterationBudget: 0,
          nextEventSequence: 2,
        }),
        observations: [],
        occurredAt: '2026-08-21T00:00:00.000Z',
        maximumAdmissions: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('compatibility release epoch');
  });

  it('advances the prepared target through the production overlap support', async () => {
    const releaseSupport = createExecutableCompatibilityReleaseSupport(
      CORE_REGISTRY_RELEASE_SUPPORT.map(composeExecutableCompatibilityRelease),
    );
    const target = composeExecutableCompatibilityRelease(
      CORE_REGISTRY_RELEASE_SUCCESSOR,
    );
    const executable = buildWorkflowExecutableV2({
      graph: graph(),
      release: target,
    });
    const currentCompatibilityRelease = releaseSupport.descriptions.at(-1);
    if (currentCompatibilityRelease === undefined)
      throw new Error('target release fixture is missing');
    const engine = createCoordinatorAdvanceEngine({
      admissionRelease: composeExecutableCompatibilityRelease(
        CORE_REGISTRY_RELEASE,
      ),
      releaseSupport,
    });

    await expect(
      engine.advance({
        runId: RUN_ID,
        workflowVersionId: VERSION_ID,
        projection: {
          id: VERSION_ID,
          workspaceId: WORKSPACE_ID,
          workflowId: WORKFLOW_ID,
          versionNumber: 1,
          schemaVersion: 1,
          checksum: executable.checksum,
          executableSchemaVersion: 2,
          executableJson: executable.envelope,
          compatibilityReleaseEpoch: target.epoch,
          currentCompatibilityRelease,
        },
        checkpoint: createCheckpoint({
          engineVersion: 'phase3-engine-v1',
          workflowVersionId: VERSION_ID,
          iterationBudget: 0,
          nextEventSequence: 2,
        }),
        observations: [],
        occurredAt: '2026-08-21T00:00:00.000Z',
        maximumAdmissions: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'transition' });
  });
});
