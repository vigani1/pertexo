import { isDeepStrictEqual } from 'node:util';
import type { ArtifactStore } from '@pertexo/artifact-store';
import {
  prepareInlineWorkflowExecutionValueV3,
  parseWorkflowExecutionValueSnapshot,
  WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
  type NodeAttemptRunStore,
} from '@pertexo/database/execution';
import { createWorkflowExecutionValueCodec } from './workflow-execution-value-codec.js';
import { createWorkflowExecutionValueWriter } from './workflow-execution-value-writer.js';

type NativeArtifactRunStore = Pick<
  NodeAttemptRunStore,
  | 'reserveNativeArtifact'
  | 'assertNativeArtifactReserved'
  | 'finalizeNativeArtifact'
  | 'readCallDeclarationInput'
  | 'readNativeValueSource'
>;

/** Locator metadata from an independently accepted SQL snapshot, not possession. */
function acceptedArtifact(
  snapshot: ReturnType<typeof parseWorkflowExecutionValueSnapshot>,
  workspaceId: string,
) {
  if (snapshot.reference.kind !== 'artifact')
    throw new Error('Accepted native artifact reference is missing');
  return {
    artifactId: snapshot.reference.artifactId,
    workspaceId,
    sha256: snapshot.sha256,
    byteLength: snapshot.byteLength,
    mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
    available: true,
  };
}

/** Framework-only composition of current SQL owners and the existing reserved writer/codec. */
export function createNodeAttemptArtifactValues(
  runStore: NativeArtifactRunStore,
  store: Pick<ArtifactStore, 'getStream' | 'put'>,
) {
  const writeReserved = createWorkflowExecutionValueWriter({
    store,
    retentionMillis: 30 * 24 * 60 * 60_000,
    persistence: {
      assertReserved: async ({ owner, reserved, signal }) => {
        if (
          owner.kind !== 'attempt' ||
          runStore.assertNativeArtifactReserved === undefined
        )
          throw new Error(
            'Native attempt artifact reservation owner is unavailable',
          );
        await runStore.assertNativeArtifactReserved({
          owner,
          reserved,
          signal,
        });
      },
      finalize: async ({ owner, reserved, signal }) => {
        if (
          owner.kind !== 'attempt' ||
          runStore.finalizeNativeArtifact === undefined
        )
          throw new Error(
            'Native attempt artifact finalization owner is unavailable',
          );
        await runStore.finalizeNativeArtifact({ owner, reserved, signal });
      },
    },
  });
  return createWorkflowExecutionValueCodec({
    store,
    writeReserved,
    chooseInline: prepareInlineWorkflowExecutionValueV3,
    reserve: async (input) => {
      if (
        input.owner.kind !== 'attempt' ||
        runStore.reserveNativeArtifact === undefined
      )
        throw new Error(
          'Native attempt artifact producer owner is unavailable',
        );
      return runStore.reserveNativeArtifact({ ...input, owner: input.owner });
    },
    authorize: async ({ owner, reference, signal }) => {
      if (
        owner.kind !== 'attempt' ||
        runStore.readCallDeclarationInput === undefined
      )
        throw new Error('Accepted Call artifact input owner is unavailable');
      const read = await runStore.readCallDeclarationInput({
        lease: owner.lease,
        signal,
      });
      if (read === undefined)
        throw new Error('Accepted Call artifact input is missing');
      const snapshot = parseWorkflowExecutionValueSnapshot(read);
      if (!isDeepStrictEqual(snapshot.reference, reference))
        throw new Error('Accepted Call artifact input reference differs');
      return acceptedArtifact(snapshot, owner.lease.workspaceId);
    },
    authorizeSource: async ({ owner, source, signal }) => {
      if (
        owner.kind !== 'attempt' ||
        runStore.readNativeValueSource === undefined
      )
        throw new Error('Native artifact current source owner is unavailable');
      const accepted = await runStore.readNativeValueSource({
        lease: owner.lease,
        source,
        signal,
      });
      if (
        accepted.slot !== source.slot ||
        !isDeepStrictEqual(accepted.source, source.source)
      )
        throw new Error(
          'Native independently accepted artifact source differs',
        );
      return {
        snapshot: accepted.snapshot,
        ...(accepted.snapshot.reference.kind === 'inline'
          ? {}
          : {
              artifact: acceptedArtifact(
                accepted.snapshot,
                owner.lease.workspaceId,
              ),
            }),
      };
    },
  });
}
