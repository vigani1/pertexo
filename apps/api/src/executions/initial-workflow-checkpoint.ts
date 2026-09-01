import type {
  CompatibilityReleaseExpectation,
  PublishedWorkflowV2Projection,
} from '@pertexo/database/api';
import {
  WorkflowEngineError,
  createCheckpoint,
  createCheckpointV2,
  type ExecutableCompatibilityReleaseSupport,
  verifyWorkflowExecutableV2,
} from '@pertexo/workflow-engine';

export const API_ENGINE_VERSION = 'phase3-engine-v1';
export const API_ITERATION_BUDGET = 1_000;

export class InitialWorkflowCheckpointError extends Error {
  public override readonly name = 'InitialWorkflowCheckpointError';
  public constructor() {
    super('The published workflow is not executable by this API release');
  }
}

/** Build the execution checkpoint shared by every API run-ingress adapter. */
export function createInitialWorkflowCheckpoint(
  projection: PublishedWorkflowV2Projection,
  releaseSupport: ExecutableCompatibilityReleaseSupport,
  currentCompatibilityRelease: CompatibilityReleaseExpectation,
) {
  try {
    const admissionDescription = releaseSupport.descriptions.find(
      ({ epoch }) => epoch === projection.compatibilityReleaseEpoch,
    );
    if (admissionDescription === undefined)
      throw new InitialWorkflowCheckpointError();
    const admissionRelease = releaseSupport.resolve(
      admissionDescription.epoch,
      admissionDescription.fingerprint,
    );
    const currentRelease = releaseSupport.resolve(
      currentCompatibilityRelease.epoch,
      currentCompatibilityRelease.fingerprint,
    );
    const executable = verifyWorkflowExecutableV2({
      envelope: projection.executableJson,
      checksum: projection.checksum,
      admissionRelease,
      currentRelease,
    });
    if (
      executable.envelope.compatibilityReleaseEpoch !==
      projection.compatibilityReleaseEpoch
    )
      throw new InitialWorkflowCheckpointError();
    return Object.freeze({
      engineVersion: API_ENGINE_VERSION,
      checkpoint: (executable.envelope.graph.nodes.some(
        ({ definition }) =>
          (definition.key === 'core.condition' ||
            definition.key === 'core.switch' ||
            definition.key === 'core.parallel') &&
          definition.version === 1,
      )
        ? createCheckpointV2
        : createCheckpoint)({
        engineVersion: API_ENGINE_VERSION,
        workflowVersionId: projection.id,
        iterationBudget: API_ITERATION_BUDGET,
        nextEventSequence: 2,
      }),
    });
  } catch (error: unknown) {
    if (error instanceof InitialWorkflowCheckpointError) throw error;
    if (error instanceof WorkflowEngineError)
      throw new InitialWorkflowCheckpointError();
    throw error;
  }
}
