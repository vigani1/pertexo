import type {
  CompatibilityReleaseExpectation,
  PublishedWorkflowExecutableProjection,
} from '@pertexo/database/api';
import {
  WorkflowEngineError,
  createCheckpoint,
  createCheckpointV2,
  type ExecutableCompatibilityReleaseSupport,
  verifyWorkflowExecutableV2,
  verifyWorkflowExecutableV3,
  createWorkflowCheckpointV3,
} from '@pertexo/workflow-engine';

export const API_ENGINE_VERSION = 'phase3-engine-v1';
const API_ITERATION_BUDGET = 1_000;

function requiresStructuredCheckpoint(definition: {
  readonly key: string;
  readonly version: number;
}): boolean {
  return (
    (definition.version === 1 &&
      (definition.key === 'core.condition' ||
        definition.key === 'core.switch' ||
        definition.key === 'core.foreach')) ||
    (definition.key === 'core.parallel' &&
      (definition.version === 1 ||
        definition.version === 2 ||
        definition.version === 3))
  );
}

export class InitialWorkflowCheckpointError extends Error {
  public override readonly name = 'InitialWorkflowCheckpointError';
  public constructor() {
    super('The published workflow is not executable by this API release');
  }
}

/** Build the execution checkpoint shared by every API run-ingress adapter. */
export function createInitialWorkflowCheckpoint(
  projection: PublishedWorkflowExecutableProjection,
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
    const boundary = {
      envelope: projection.executableJson,
      checksum: projection.checksum,
      admissionRelease,
      currentRelease,
    };
    const native = projection.executableSchemaVersion === 3;
    // Runtime metadata still comes from a database projection. Do not rely on
    // the TypeScript discriminant to validate that decoded format pairing.
    const sourceSchemaVersion: unknown = projection.schemaVersion;
    if (native && sourceSchemaVersion !== 2)
      throw new InitialWorkflowCheckpointError();
    const executable = native
      ? verifyWorkflowExecutableV3(boundary)
      : verifyWorkflowExecutableV2(boundary);
    if (
      executable.envelope.compatibilityReleaseEpoch !==
      projection.compatibilityReleaseEpoch
    )
      throw new InitialWorkflowCheckpointError();
    const checkpointFactory = native
      ? createWorkflowCheckpointV3
      : executable.envelope.graph.nodes.some(({ definition }) =>
            requiresStructuredCheckpoint(definition),
          )
        ? createCheckpointV2
        : createCheckpoint;
    return Object.freeze({
      engineVersion: API_ENGINE_VERSION,
      checkpoint: checkpointFactory({
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
