import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import { CoordinatorPlanInvalidError } from './coordinator-run-store-contract.js';
import { parseCoordinatorNativeSourceInventory } from './coordinator-native-source-inventory.js';
import { parseNativeNodeAttemptValueSource } from '../node-attempts/native-node-attempt-value-sources.js';
import type {
  NativeCallableValueDescriptor,
  NativeCoordinatorValueOwner,
  NativeCoordinatorMaterialDemand,
} from './coordinator-native-value-read-contract.js';

/** Selected original-byte context on the existing scoped read client, not authority. */
export async function loadNativeCoordinatorResultContext(
  client: PoolClient,
  {
    owner,
    demand,
  }: Readonly<{
    owner: NativeCoordinatorValueOwner;
    demand: NativeCoordinatorMaterialDemand;
  }>,
) {
  const nodeOutputs: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  const inventory = await client.query<{ result: unknown }>(
    'select app.load_native_coordinator_value_sources($1::jsonb,$2::jsonb) as result',
    [JSON.stringify(owner), JSON.stringify(demand)],
  );
  if (inventory.rows.length !== 1) throw new CoordinatorPlanInvalidError();
  const ready = z
    .object({ kind: z.literal('ready'), projection: z.unknown() })
    .strict()
    .parse(inventory.rows[0]?.result);
  const projection = parseCoordinatorNativeSourceInventory(
    ready.projection,
    owner,
    demand,
  );
  const read = async (
    descriptor: NativeCallableValueDescriptor,
  ): Promise<JsonValue> => {
    const rows = await client.query<{ result: unknown }>(
      'select app.read_native_coordinator_value_source($1::jsonb,$2::jsonb) as result',
      [JSON.stringify(owner), JSON.stringify(descriptor)],
    );
    if (rows.rows.length !== 1) throw new CoordinatorPlanInvalidError();
    const fetched = z
      .object({ kind: z.literal('ready'), valueSource: z.unknown() })
      .strict()
      .parse(rows.rows[0]?.result);
    const accepted = parseNativeNodeAttemptValueSource(fetched.valueSource);
    if (
      accepted.slot !== descriptor.slot ||
      !isDeepStrictEqual(accepted.source, descriptor.source) ||
      accepted.snapshot.reference.kind !==
        descriptor.valueIdentity.reference.kind ||
      accepted.snapshot.sha256 !== descriptor.valueIdentity.sha256 ||
      accepted.snapshot.byteLength !== descriptor.valueIdentity.byteLength
    )
      throw new CoordinatorPlanInvalidError();
    if (accepted.snapshot.reference.kind !== 'inline')
      throw new Error('Native result artifact preparation is not implemented');
    return accepted.snapshot.reference.value;
  };
  const runInput =
    projection.runInput === null ? null : await read(projection.runInput);
  for (const source of demand.sources) {
    const selected = projection.outputs.find(
      ({ invocationKey }) => invocationKey === source.invocationKey,
    );
    if (selected === undefined) throw new CoordinatorPlanInvalidError();
    nodeOutputs[source.nodeId] = await read(selected.valueSource);
  }
  return { runInput, nodeOutputs };
}
