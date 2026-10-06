import { isDeepStrictEqual } from 'node:util';
import type { ArtifactStore } from '@pertexo/artifact-store';
import { createNodeAttemptArtifactValues } from './node-attempt-artifact-values.js';
import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import {
  parseWorkflowExecutionValueSnapshot,
  type NodeAttemptRunStore,
} from '@pertexo/database/execution';
import type { NodeAttemptHandlerDependencies } from './node-attempt-handler.js';
import {
  createWorkflowExecutionValueSourceHydrator,
  createWorkflowExecutionValueInlinePreparation,
} from './workflow-execution-value-codec.js';

const active = (signal: AbortSignal) => {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
};

/** Framework-only composition; borrowed store is never an executor capability. */
export function createNodeAttemptValueComposition(
  runStore: Pick<
    NodeAttemptRunStore,
    | 'readNativeValueSource'
    | 'readCallDeclarationInput'
    | 'reserveNativeArtifact'
    | 'assertNativeArtifactReserved'
    | 'finalizeNativeArtifact'
  >,
  artifactStore?: Pick<ArtifactStore, 'put' | 'getStream'>,
): {
  physicalOutputValues: NonNullable<
    NodeAttemptHandlerDependencies['physicalOutputValues']
  >;
  nativeInputValues: NonNullable<
    NodeAttemptHandlerDependencies['nativeInputValues']
  >;
  callDeclarationValues: NonNullable<
    NodeAttemptHandlerDependencies['callDeclarationValues']
  >;
} {
  const artifactValues =
    artifactStore === undefined
      ? undefined
      : createNodeAttemptArtifactValues(runStore, artifactStore);
  const nativeInputValues =
    artifactValues ??
    createWorkflowExecutionValueSourceHydrator({
      authorizeSource: async ({ owner, source, signal }) => {
        if (owner.kind !== 'attempt')
          throw new TypeError('Native attempt consumer scope differs');
        const read = runStore.readNativeValueSource;
        if (read === undefined)
          throw new Error('Native attempt source owner is unavailable');
        const accepted = await read.call(runStore, {
          lease: owner.lease,
          source,
          signal,
        });
        if (
          accepted.slot !== source.slot ||
          !isDeepStrictEqual(accepted.source, source.source)
        )
          throw new TypeError(
            'Native attempt independently accepted source scope differs',
          );
        if (accepted.snapshot.reference.kind !== 'inline')
          throw new Error(
            'Native attempt artifact source hydration is not implemented',
          );
        return { snapshot: accepted.snapshot };
      },
    });
  const callDeclarationValues: NonNullable<
    NodeAttemptHandlerDependencies['callDeclarationValues']
  > = {
    prepare: ({ owner, value, signal }) => {
      active(signal);
      if (owner.kind !== 'attempt' || owner.slot !== 'call_input')
        throw new TypeError('Call declaration producer scope differs');
      return (
        artifactValues ?? createWorkflowExecutionValueInlinePreparation()
      ).prepare({
        owner,
        value,
        signal,
      });
    },
    hydrate: async ({ owner, reference, signal }) => {
      active(signal);
      if (owner.kind !== 'attempt')
        throw new TypeError('Call declaration consumer scope differs');
      const read = runStore.readCallDeclarationInput;
      if (read === undefined)
        throw new Error('Call declaration accepted input owner is unavailable');
      const value = await read.call(runStore, { lease: owner.lease, signal });
      active(signal);
      if (value === undefined)
        throw new Error('Call declaration accepted input is unavailable');
      const accepted = parseWorkflowExecutionValueSnapshot(value);
      if (!isDeepStrictEqual(accepted.reference, reference))
        throw new TypeError(
          'Call declaration independently accepted reference differs',
        );
      if (accepted.reference.kind !== 'inline') {
        if (artifactValues !== undefined)
          return artifactValues.hydrate({ owner, reference, signal });
        throw new Error(
          'Call declaration artifact hydration is not implemented',
        );
      }
      return boundedNodeJsonSchema.parse(accepted.reference.value);
    },
  };
  const physicalOutputValues: NonNullable<
    NodeAttemptHandlerDependencies['physicalOutputValues']
  > = {
    prepare: (input) => {
      active(input.signal);
      if (
        input.owner.kind !== 'attempt' ||
        input.owner.slot !== 'physical_output'
      )
        throw new TypeError('Physical output producer scope differs');
      return (
        artifactValues ?? createWorkflowExecutionValueInlinePreparation()
      ).prepare(input);
    },
  };
  return { nativeInputValues, callDeclarationValues, physicalOutputValues };
}
