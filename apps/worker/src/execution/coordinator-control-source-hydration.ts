import { isDeepStrictEqual } from 'node:util';
import type { ArtifactStore } from '@pertexo/artifact-store';
import {
  parseNativeNodeAttemptValueSource,
  WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
  type CoordinatorRunStore,
  type NativeCoordinatorControlDeclarationSource,
  type NativeCoordinatorValueOwner,
} from '@pertexo/database/execution';
import { CallableCompletionStoppedError } from '@pertexo/workflow-engine';
import { createWorkflowExecutionValueSourceHydrator } from './workflow-execution-value-codec.js';

function active(signal: AbortSignal): void {
  if (signal.aborted)
    throw new CallableCompletionStoppedError({ kind: 'context_aborted' });
}

/** Selected original bytes only; all authority is rechecked by the actual reader. */
export function createCoordinatorControlSourceHydration(
  runStore: Pick<CoordinatorRunStore, 'readCoordinatorControlSource'>,
  controlReadTimeoutMillis: number,
  store?: Pick<ArtifactStore, 'getStream'>,
) {
  return async (
    input: Readonly<{
      owner: NativeCoordinatorValueOwner;
      source: NativeCoordinatorControlDeclarationSource;
      signal: AbortSignal;
    }>,
  ): Promise<unknown> => {
    active(input.signal);
    const read = runStore.readCoordinatorControlSource;
    if (read === undefined)
      throw new CallableCompletionStoppedError({
        kind: 'unavailable',
        reason: 'source_read_failed',
      });
    const fresh = async (signal: AbortSignal) => {
      active(signal);
      const response = await read.call(runStore, {
        owner: input.owner,
        source: input.source,
        signal,
        readTimeoutMillis: controlReadTimeoutMillis,
      });
      active(signal);
      if (response.kind === 'stopped')
        throw new CallableCompletionStoppedError(response.stop);
      const accepted = parseNativeNodeAttemptValueSource(response.valueSource);
      const expected = input.source.valueSource;
      const snapshot = accepted.snapshot;
      const reference =
        snapshot.reference.kind === 'inline'
          ? { schemaVersion: 1, kind: 'inline' }
          : snapshot.reference;
      if (
        accepted.slot !== expected.slot ||
        !isDeepStrictEqual(accepted.source, expected.source) ||
        !isDeepStrictEqual(reference, expected.valueIdentity.reference) ||
        snapshot.sha256 !== expected.valueIdentity.sha256 ||
        snapshot.byteLength !== expected.valueIdentity.byteLength
      )
        throw new TypeError('Coordinator control original source differs');
      return accepted;
    };
    const source = await fresh(input.signal);
    const codec = createWorkflowExecutionValueSourceHydrator({
      ...(store === undefined ? {} : { store }),
      authorizeSource: async ({ owner, source: requested, signal }) => {
        if (
          owner.kind !== 'run_result' ||
          requested.slot !== 'upstream_output' ||
          !isDeepStrictEqual(requested.source, input.source.valueSource.source)
        )
          throw new TypeError('Coordinator control codec consumer differs');
        const accepted = await fresh(signal);
        return {
          snapshot: accepted.snapshot,
          ...(accepted.snapshot.reference.kind === 'inline'
            ? {}
            : {
                artifact: {
                  artifactId: accepted.snapshot.reference.artifactId,
                  workspaceId: input.owner.workspaceId,
                  sha256: accepted.snapshot.sha256,
                  byteLength: accepted.snapshot.byteLength,
                  mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
                  available: true,
                },
              }),
        };
      },
    });
    const value = await codec.hydrateSource({
      owner: { kind: 'run_result', ...input.owner },
      source,
      signal: input.signal,
    });
    active(input.signal);
    // A stream may outlive its first authorization. Re-derive the full selected
    // descriptor after original-byte work, under the same borrowed lifetime.
    await fresh(input.signal);
    active(input.signal);
    return value;
  };
}
