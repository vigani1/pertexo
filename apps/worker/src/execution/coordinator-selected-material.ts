import type {
  CoordinatorRunStore,
  NativeCallableValueDescriptor,
  NativeCoordinatorValueOwner,
} from '@pertexo/database/execution';
import {
  parseCoordinatorNativeSourceInventory,
  parseNativeNodeAttemptValueSource,
} from '@pertexo/database/execution';
import {
  CallableCompletionStoppedError,
  type CallableMaterialDemand,
  type CallableMaterialDemandResult,
} from '@pertexo/workflow-engine';
import { callableValueWorkStopSchema } from '@pertexo/workflow-model/workflow-call-contract';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type {
  CoordinatorValueWorkPolicy,
  CoordinatorValueWorkSession,
} from './coordinator-value-work-lifetime.js';
import { hydrateCoordinatorExpressionMaterial } from './coordinator-expression-material-hydration.js';
import type { createWorkflowExecutionValueCodec } from './workflow-execution-value-codec.js';

const stoppedReply = z
  .object({ kind: z.literal('stopped'), stop: callableValueWorkStopSchema })
  .strict();
const inventoryReply = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), projection: z.unknown() }).strict(),
  stoppedReply,
]);
const sourceReply = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), valueSource: z.unknown() }).strict(),
  stoppedReply,
]);

export async function loadSelectedCoordinatorMaterial(
  input: Readonly<{
    owner: NativeCoordinatorValueOwner;
    demand: CallableMaterialDemand;
    session: CoordinatorValueWorkSession;
    runStore: CoordinatorRunStore;
    valueWork: Readonly<{
      policy: Pick<CoordinatorValueWorkPolicy, 'controlReadTimeoutMillis'>;
      hydrateSource?: ReturnType<
        typeof createWorkflowExecutionValueCodec
      >['hydrateSource'];
    }>;
  }>,
): Promise<CallableMaterialDemandResult> {
  const loadSources = input.runStore.loadCallableCompletionSources;
  const readSource = input.runStore.readCallableCompletionSource;
  const hydrateSource = input.valueWork.hydrateSource;
  const { session, owner, demand } = input;
  if (
    loadSources === undefined ||
    readSource === undefined ||
    hydrateSource === undefined
  )
    return session.perform(() =>
      Promise.resolve({
        kind: 'stopped',
        stop: { kind: 'unavailable', reason: 'source_read_failed' },
      }),
    );
  const inventory = inventoryReply.parse(
    await session.perform((signal) =>
      loadSources.call(input.runStore, {
        owner: structuredClone(owner),
        demand: structuredClone(demand),
        signal,
        readTimeoutMillis: input.valueWork.policy.controlReadTimeoutMillis,
      }),
    ),
  );
  if (inventory.kind === 'stopped')
    throw new CallableCompletionStoppedError(inventory.stop);
  const projection = parseCoordinatorNativeSourceInventory(
    inventory.projection,
    owner,
    demand,
  );
  const hydrate = async (
    descriptor: NativeCallableValueDescriptor,
  ): Promise<unknown> => {
    const fetched = sourceReply.parse(
      await session.perform((signal) =>
        readSource.call(input.runStore, {
          owner: structuredClone(owner),
          source: structuredClone(descriptor),
          signal,
          readTimeoutMillis: input.valueWork.policy.controlReadTimeoutMillis,
        }),
      ),
    );
    if (fetched.kind === 'stopped')
      throw new CallableCompletionStoppedError(fetched.stop);
    const source = parseNativeNodeAttemptValueSource(fetched.valueSource);
    const identity = descriptor.valueIdentity;
    const snapshot = source.snapshot;
    const reference =
      snapshot.reference.kind === 'inline'
        ? { schemaVersion: 1, kind: 'inline' }
        : snapshot.reference;
    if (
      source.slot !== descriptor.slot ||
      !isDeepStrictEqual(source.source, descriptor.source) ||
      !isDeepStrictEqual(reference, identity.reference) ||
      snapshot.sha256 !== identity.sha256 ||
      snapshot.byteLength !== identity.byteLength
    )
      throw new TypeError('Coordinator fetched source identity does not agree');
    return session.perform((signal) =>
      hydrateSource({
        owner: { kind: 'run_result', ...structuredClone(owner) },
        source,
        signal,
      }),
    );
  };
  const readRunInput = () =>
    projection.runInput === null
      ? Promise.resolve(null)
      : hydrate(projection.runInput);
  if (demand.resultSelector.kind === 'expression')
    return hydrateCoordinatorExpressionMaterial(
      demand,
      {
        readRunInput,
        readOutput: (source) => {
          const selected = projection.outputs.find(
            ({ invocationKey }) => invocationKey === source.invocationKey,
          );
          if (selected === undefined)
            throw new TypeError('Coordinator selected source is missing');
          return hydrate(selected.valueSource);
        },
      },
      session.signal,
    );
  const runInput = demand.requiresRunInput ? await readRunInput() : null;
  const outputs = [];
  for (const selected of projection.outputs)
    outputs.push({
      invocationKey: selected.invocationKey,
      output: selected.output,
      value: await hydrate(selected.valueSource),
    });
  return { kind: 'ready', material: { runInput, outputs } };
}
