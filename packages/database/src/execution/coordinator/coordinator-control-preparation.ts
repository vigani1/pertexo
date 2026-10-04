import type { Pool } from 'pg';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import type {
  NativeCoordinatorControlSourceHydrator,
  NativeCoordinatorValueOwner,
} from './coordinator-native-value-read-contract.js';
import {
  assertCoordinatorNotAborted,
  withCoordinatorReadClient,
} from './coordinator-run-store-transactions.js';
import { serializeWorkflowExecutionJsonValueV3 } from '../stored-execution-value.js';
import { loadCoordinatorControlPrecommitMaterial } from './coordinator-control-precommit-material.js';
import {
  validateCoordinatorControlDeclarationSet,
  validateCoordinatorControlValue,
} from './coordinator-control-value-validation.js';

/** Independent fresh precommit S. Returned data are ordinary parameters, never authority. */
export async function prepareCoordinatorControls(
  pool: Pool,
  input: Readonly<{
    owner: NativeCoordinatorValueOwner;
    plan: ParsedTransitionPlan;
    signal: AbortSignal;
    readTimeoutMillis: number;
    hydrate: NativeCoordinatorControlSourceHydrator | undefined;
  }>,
) {
  assertCoordinatorNotAborted(input.signal);
  const material = await withCoordinatorReadClient(
    pool,
    input.owner.workspaceId,
    input.signal,
    (client) =>
      loadCoordinatorControlPrecommitMaterial(client, input.owner, input.plan),
    input.readTimeoutMillis,
  );
  assertCoordinatorNotAborted(input.signal);
  const collections: {
    invocationKey: string;
    collectionSize: number;
    collectionChecksum: string;
  }[] = [];
  serializeWorkflowExecutionJsonValueV3({
    sources: material.sources,
    collections,
  });
  for (const source of material.sources) {
    const hydrate = input.hydrate;
    if (hydrate === undefined)
      throw new Error('Native independent control hydration is unavailable');
    assertCoordinatorNotAborted(input.signal);
    // Each decoded value remains inside this iteration. Only the small derived
    // collection facts and exact original descriptor survive it.
    const value = await hydrate({
      owner: input.owner,
      source,
      signal: input.signal,
    });
    assertCoordinatorNotAborted(input.signal);
    const collection = validateCoordinatorControlValue(
      material,
      input.plan,
      source,
      value,
    );
    if (collection !== undefined)
      collections.push({ invocationKey: source.invocationKey, ...collection });
    serializeWorkflowExecutionJsonValueV3({
      sources: material.sources,
      collections,
    });
  }
  validateCoordinatorControlDeclarationSet(material, input.plan);
  return { sources: material.sources, collections };
}
