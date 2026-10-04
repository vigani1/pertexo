import type { ArtifactStore } from '@pertexo/artifact-store';
import {
  prepareInlineWorkflowExecutionValueV3,
  type CoordinatorRunStore,
} from '@pertexo/database/execution';
import {
  createWorkflowExecutionValueInlinePreparation,
  createWorkflowExecutionValuePreparation,
} from './workflow-execution-value-codec.js';
import { createWorkflowExecutionValueWriter } from './workflow-execution-value-writer.js';

/** Borrowed existing framework writer/codec. No storage/expiry/quota/lifetime owner is created. */
export function createCoordinatorResultValuePreparation(
  runStore: Pick<
    CoordinatorRunStore,
    | 'reserveNativeResultArtifact'
    | 'assertNativeResultArtifactReserved'
    | 'finalizeNativeResultArtifact'
  >,
  store?: Partial<Pick<ArtifactStore, 'put'>>,
) {
  const reserve = runStore.reserveNativeResultArtifact;
  const assertReserved = runStore.assertNativeResultArtifactReserved;
  const finalize = runStore.finalizeNativeResultArtifact;
  const put = store?.put;
  if (
    reserve === undefined ||
    assertReserved === undefined ||
    finalize === undefined ||
    put === undefined
  )
    return createWorkflowExecutionValueInlinePreparation();
  const writeReserved = createWorkflowExecutionValueWriter({
    store: { put: (request) => put.call(store, request) },
    retentionMillis: 30 * 24 * 60 * 60_000,
    persistence: {
      assertReserved: async ({ owner, reserved, signal }) => {
        if (owner.kind !== 'run_result')
          throw new TypeError('Coordinator result producer scope differs');
        await assertReserved.call(runStore, { owner, reserved, signal });
      },
      finalize: async ({ owner, reserved, signal }) => {
        if (owner.kind !== 'run_result')
          throw new TypeError('Coordinator result producer scope differs');
        await finalize.call(runStore, { owner, reserved, signal });
      },
    },
  });
  return createWorkflowExecutionValuePreparation({
    chooseInline: prepareInlineWorkflowExecutionValueV3,
    writeReserved,
    reserve: (request) => {
      if (request.owner.kind !== 'run_result')
        throw new TypeError('Coordinator result producer scope differs');
      return reserve.call(runStore, { ...request, owner: request.owner });
    },
  });
}
