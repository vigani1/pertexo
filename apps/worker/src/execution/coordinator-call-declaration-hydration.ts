import type { ArtifactStore } from '@pertexo/artifact-store';
import {
  WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
  type CoordinatorRunStore,
  type NativeCoordinatorCallDeclarationSource,
  type NativeCoordinatorValueOwner,
} from '@pertexo/database/execution';
import { CallableCompletionStoppedError } from '@pertexo/workflow-engine';
import { isDeepStrictEqual } from 'node:util';
import { createWorkflowExecutionValueHydrator } from './workflow-execution-value-codec.js';
import type { CoordinatorAdvanceEngine } from './coordinator-handler.js';
import type { CoordinatorValueWorkSession } from './coordinator-value-work-lifetime.js';

/** Hydrate only selected immutable declarations, serially in the caller's lifetime. */
export async function hydrateCoordinatorCallDeclarations(
  materials: NonNullable<
    Parameters<CoordinatorAdvanceEngine['advance']>[0]['workflowCalls']
  >,
  owner: NativeCoordinatorValueOwner,
  session: CoordinatorValueWorkSession,
  hydrate:
    ReturnType<typeof createCoordinatorCallDeclarationHydration> | undefined,
) {
  if (materials.declarations.length > 64)
    throw new TypeError(
      'Coordinator Call declarations exceed the existing bound',
    );
  const declarations = [];
  for (const declaration of materials.declarations) {
    const { artifactSource, ...material } = declaration;
    if (artifactSource === undefined) {
      declarations.push(material);
      continue;
    }
    if (
      material.invocationKey !== artifactSource.invocationKey ||
      material.nodeId !== artifactSource.nodeId ||
      material.declarationAttemptId !== artifactSource.declarationAttemptId ||
      material.calleeVersionId !== artifactSource.calleeVersionId ||
      material.inputChecksum !== artifactSource.snapshot.sha256 ||
      material.input.kind !== 'artifact' ||
      material.input.artifactId !== artifactSource.snapshot.reference.artifactId
    )
      throw new TypeError(
        'Coordinator Call declaration material identity differs',
      );
    const value = await session.perform((signal) => {
      if (hydrate === undefined)
        throw new CallableCompletionStoppedError({
          kind: 'unavailable',
          reason: 'source_read_failed',
        });
      return hydrate({ owner, source: artifactSource, signal });
    });
    declarations.push({ ...material, value });
  }
  return { ...materials, declarations };
}

/** Fresh SQL authority, released before the shared original-byte codec reads storage. */
export function createCoordinatorCallDeclarationHydration(
  runStore: Pick<CoordinatorRunStore, 'readCoordinatorCallDeclaration'>,
  store: Pick<ArtifactStore, 'getStream'> | undefined,
  controlReadTimeoutMillis: number,
) {
  return async (
    input: Readonly<{
      owner: NativeCoordinatorValueOwner;
      source: NativeCoordinatorCallDeclarationSource;
      signal: AbortSignal;
    }>,
  ): Promise<unknown> => {
    const read = runStore.readCoordinatorCallDeclaration;
    if (read === undefined || store === undefined)
      throw new CallableCompletionStoppedError({
        kind: 'unavailable',
        reason: 'source_read_failed',
      });
    const codec = createWorkflowExecutionValueHydrator({
      store,
      authorize: async ({ owner, reference, signal }) => {
        if (
          owner.kind !== 'run_result' ||
          !isDeepStrictEqual(reference, input.source.snapshot.reference)
        )
          throw new TypeError('Coordinator Call declaration consumer differs');
        const accepted = await read.call(runStore, {
          owner: input.owner,
          source: input.source,
          signal,
          readTimeoutMillis: controlReadTimeoutMillis,
        });
        if (accepted.kind === 'stopped')
          throw new CallableCompletionStoppedError(accepted.stop);
        if (!isDeepStrictEqual(accepted.source, input.source))
          throw new TypeError(
            'Coordinator Call declaration accepted identity differs',
          );
        return {
          artifactId: accepted.source.snapshot.reference.artifactId,
          workspaceId: input.owner.workspaceId,
          sha256: accepted.source.snapshot.sha256,
          byteLength: accepted.source.snapshot.byteLength,
          mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
          available: true,
        };
      },
    });
    return codec.hydrate({
      owner: { kind: 'run_result', ...input.owner },
      reference: input.source.snapshot.reference,
      signal: input.signal,
    });
  };
}
