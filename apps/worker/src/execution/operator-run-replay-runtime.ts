import {
  canonicalOutboxPayloadChecksum,
  createOperatorRunReplayStore,
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
  OperatorRunReplayMismatchError,
  OperatorRunReplayNotExecutableError,
  type DatabaseConfig,
  type DatabaseRuntime,
  type OperatorRunReplayStore,
  type PublishedWorkflowV2Projection,
} from '@pertexo/database/execution';
import {
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
import {
  unrecoverableQueueError,
  type QueueDelivery,
  type QueueHandlerContext,
} from '@pertexo/queue';
import {
  composeExecutableCompatibilityRelease,
  createCheckpoint,
  createCheckpointV2,
  createExecutableCompatibilityReleaseHistory,
  createExecutableCompatibilityReleaseSupport,
  verifyWorkflowExecutableV2,
  WorkflowEngineError,
} from '@pertexo/workflow-engine';

type ReplayDelivery = Extract<
  QueueDelivery,
  { readonly name: 'replay-workflow-run' }
>;

export function createDatabaseOperatorRunReplayStore(
  database: DatabaseConfig,
  releaseCohort: PlatformReleaseCohort = 'core',
  runtime?: DatabaseRuntime,
): OperatorRunReplayStore {
  const releaseHistory = createExecutableCompatibilityReleaseHistory(
    platformExecutableRegistryHistory(releaseCohort).map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const releaseSupport = createExecutableCompatibilityReleaseSupport(
    platformRegistryReleaseSupport(releaseCohort).map(
      composeExecutableCompatibilityRelease,
    ),
  );
  return createOperatorRunReplayStore(
    database,
    releaseSupport.descriptions,
    (projection, currentCompatibilityRelease) => {
      try {
        return initialCheckpoint(
          projection,
          releaseHistory,
          currentCompatibilityRelease,
        );
      } catch (error: unknown) {
        if (error instanceof WorkflowEngineError)
          throw new OperatorRunReplayNotExecutableError();
        throw error;
      }
    },
    runtime,
  );
}

function initialCheckpoint(
  projection: PublishedWorkflowV2Projection,
  releaseHistory: ReturnType<
    typeof createExecutableCompatibilityReleaseHistory
  >,
  currentCompatibilityRelease: Readonly<{
    epoch: number;
    fingerprint: string;
  }>,
) {
  const admissionDescription = releaseHistory.descriptions.find(
    ({ epoch }) => epoch === projection.compatibilityReleaseEpoch,
  );
  if (admissionDescription === undefined)
    throw new OperatorRunReplayNotExecutableError();
  const executable = verifyWorkflowExecutableV2({
    envelope: projection.executableJson,
    checksum: projection.checksum,
    admissionRelease: releaseHistory.resolve(
      admissionDescription.epoch,
      admissionDescription.fingerprint,
    ),
    currentRelease: releaseHistory.resolve(
      currentCompatibilityRelease.epoch,
      currentCompatibilityRelease.fingerprint,
    ),
  });
  const engineVersion = 'phase3-engine-v1';
  return Object.freeze({
    engineVersion,
    checkpoint: (executable.envelope.graph.nodes.some(
      ({ definition }) =>
        (definition.key === 'core.condition' ||
          definition.key === 'core.switch' ||
          definition.key === 'core.parallel') &&
        definition.version === 1,
    )
      ? createCheckpointV2
      : createCheckpoint)({
      engineVersion,
      workflowVersionId: projection.id,
      iterationBudget: 1_000,
      nextEventSequence: 2,
    }),
  });
}

export function createOperatorRunReplayHandler(store: OperatorRunReplayStore) {
  return Object.freeze({
    handle: async (delivery: ReplayDelivery, context: QueueHandlerContext) => {
      try {
        return await store.replay({
          commandId: delivery.data.commandId,
          delivery: {
            outboxEventId: delivery.data.outboxEventId,
            payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
          },
          signal: context.signal,
          workspaceId: delivery.data.workspaceId,
        });
      } catch (error: unknown) {
        if (error instanceof OperatorRunReplayNotExecutableError) {
          await store.fail({
            commandId: delivery.data.commandId,
            safeErrorCode: 'version_not_executable',
            workspaceId: delivery.data.workspaceId,
          });
          throw unrecoverableQueueError('Run replay target is not executable');
        }
        if (
          error instanceof OperatorRunReplayMismatchError ||
          error instanceof InboxChecksumMismatchError ||
          error instanceof InboxReceiptUnavailableError
        )
          throw unrecoverableQueueError(
            'Run replay failed durable state verification',
          );
        throw error;
      }
    },
  });
}
