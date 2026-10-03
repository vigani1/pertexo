import {
  boundedNodeJsonRecordSchema,
  boundedNodeJsonSchema,
  type SchemaJson,
} from '@pertexo/node-sdk';
import type {
  CallableMaterialDemand,
  CallableMaterialDemandResult,
} from '@pertexo/workflow-engine';
import { inspectJsonValue } from '@pertexo/workflow-model/canonical-json';
import { EXPRESSION_POLICY_V1 } from '@pertexo/workflow-model/expressions';

type SelectedSource = CallableMaterialDemand['sources'][number];
export type CoordinatorExpressionMaterialReads = Readonly<{
  readRunInput(signal: AbortSignal): Promise<unknown>;
  readOutput(source: SelectedSource, signal: AbortSignal): Promise<unknown>;
}>;

function assertActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException(
      'Coordinator material hydration aborted',
      'AbortError',
    );
}

function validContext(
  runInput: SchemaJson,
  nodeOutputs: Record<string, SchemaJson>,
): boolean {
  if (!boundedNodeJsonRecordSchema.safeParse(nodeOutputs).success) return false;
  const context = inspectJsonValue({ runInput, nodeOutputs });
  return (
    context.bytes <= EXPRESSION_POLICY_V1.inputBytes &&
    context.depth <= EXPRESSION_POLICY_V1.inputDepth &&
    context.members <= EXPRESSION_POLICY_V1.inputMembers
  );
}

/** Decoded bounds only: external reads must prove source/consumption authority. */
export async function hydrateCoordinatorExpressionMaterial(
  demand: CallableMaterialDemand,
  reads: CoordinatorExpressionMaterialReads,
  signal: AbortSignal,
): Promise<CallableMaterialDemandResult> {
  assertActive(signal);
  const request = structuredClone(demand);
  const keys = new Set(request.sources.map(({ nodeId }) => nodeId));
  const invocations = new Set(
    request.sources.map(({ invocationKey }) => invocationKey),
  );
  if (
    request.resultSelector.kind !== 'expression' ||
    !request.requiresRunInput ||
    request.sources.length > 1_000 ||
    keys.size !== request.sources.length ||
    invocations.size !== request.sources.length
  )
    throw new TypeError('Coordinator expression demand inventory is invalid');
  const input = boundedNodeJsonSchema.safeParse(
    await reads.readRunInput(signal),
  );
  assertActive(signal);
  if (!input.success) return { kind: 'invalid_context' };
  const record: Record<string, SchemaJson> = Object.create(null) as Record<
    string,
    SchemaJson
  >;
  if (!validContext(input.data, record)) return { kind: 'invalid_context' };
  const outputs: {
    invocationKey: string;
    output: SelectedSource['output'];
    value: SchemaJson;
  }[] = [];
  for (const source of request.sources) {
    assertActive(signal);
    const parsed = boundedNodeJsonSchema.safeParse(
      await reads.readOutput(structuredClone(source), signal),
    );
    assertActive(signal);
    if (!parsed.success) return { kind: 'invalid_context' };
    record[source.nodeId] = parsed.data;
    if (!validContext(input.data, record)) return { kind: 'invalid_context' };
    outputs.push({
      invocationKey: source.invocationKey,
      output: source.output,
      value: parsed.data,
    });
  }
  return { kind: 'ready', material: { runInput: input.data, outputs } };
}
