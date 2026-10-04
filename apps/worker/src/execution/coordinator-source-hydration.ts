import { isDeepStrictEqual } from 'node:util';
import type { ArtifactStore } from '@pertexo/artifact-store';
import {
  parseNativeNodeAttemptValueSource,
  WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
  type CoordinatorRunStore,
  type NativeCallableValueDescriptor,
} from '@pertexo/database/execution';
import { CallableCompletionStoppedError } from '@pertexo/workflow-engine';
import { createWorkflowExecutionValueSourceHydrator } from './workflow-execution-value-codec.js';

/** Production read composition: exact current owner reread, then shared codec. */
export function createCoordinatorSourceHydration(
  runStore: Pick<CoordinatorRunStore, 'readCallableCompletionSource'>,
  controlReadTimeoutMillis: number,
  store?: Pick<ArtifactStore, 'getStream'>,
) {
  return createWorkflowExecutionValueSourceHydrator({
    ...(store === undefined ? {} : { store }),
    authorizeSource: async ({ owner, source, signal }) => {
      if (owner.kind !== 'run_result' || source.slot === 'wait_resume_output')
        throw new TypeError('Coordinator source consumer scope differs');
      const read = runStore.readCallableCompletionSource;
      if (read === undefined)
        throw new Error('Native coordinator source owner is unavailable');
      const snapshot = source.snapshot;
      const valueIdentity: NativeCallableValueDescriptor['valueIdentity'] = {
        reference:
          snapshot.reference.kind === 'inline'
            ? { schemaVersion: 1 as const, kind: 'inline' as const }
            : snapshot.reference,
        sha256: snapshot.sha256,
        byteLength: snapshot.byteLength,
        mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
      };
      const descriptor: NativeCallableValueDescriptor =
        source.slot === 'run_input'
          ? { slot: 'run_input', source: source.source, valueIdentity }
          : { slot: 'upstream_output', source: source.source, valueIdentity };
      const reply = await read.call(runStore, {
        owner: {
          workspaceId: owner.workspaceId,
          runId: owner.runId,
          workflowVersionId: owner.workflowVersionId,
          expectedRevision: owner.expectedRevision,
          delivery: owner.delivery,
        },
        source: descriptor,
        signal,
        readTimeoutMillis: controlReadTimeoutMillis,
      });
      if (reply.kind === 'stopped')
        throw new CallableCompletionStoppedError(reply.stop);
      const accepted = parseNativeNodeAttemptValueSource(reply.valueSource);
      if (
        accepted.slot !== source.slot ||
        !isDeepStrictEqual(accepted.source, source.source)
      )
        throw new TypeError(
          'Coordinator independently accepted source scope differs',
        );
      return {
        snapshot: accepted.snapshot,
        ...(accepted.snapshot.reference.kind === 'inline'
          ? {}
          : {
              artifact: {
                artifactId: accepted.snapshot.reference.artifactId,
                workspaceId: owner.workspaceId,
                sha256: accepted.snapshot.sha256,
                byteLength: accepted.snapshot.byteLength,
                mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
                available: true,
              },
            }),
      };
    },
  }).hydrateSource;
}
