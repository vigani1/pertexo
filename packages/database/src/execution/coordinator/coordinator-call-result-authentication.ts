import type { PoolClient } from 'pg';
import { validateCallableValueV1 } from '@pertexo/workflow-model';
import { workflowCallableDeclarationSchemaV1 } from '@pertexo/workflow-model/callable-graph-contract';
import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import {
  inspectExpressionNodeOutputReferences,
  type ExpressionEvaluator,
} from '@pertexo/workflow-model/expressions';
import { resolveValueSource } from '@pertexo/workflow-model/mapping';
import { loadCoordinatorCallableMaterials } from './coordinator-callable-materials.js';
import { loadCoordinatorCallFacts } from './coordinator-call-facts.js';
import { CoordinatorPlanInvalidError } from './coordinator-run-store-contract.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import { serializeWorkflowExecutionJsonValueV3 } from '../stored-execution-value.js';
import type { CoordinatorAdvanceDelivery } from './coordinator-run-store-contract.js';
import { loadNativeCoordinatorResultContext } from './coordinator-native-result-context.js';

/** Load bounded accepted material in a short read owner; no evaluator runs here. */
export async function loadCoordinatorCallResultAuthentication(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    workflowVersionId: string;
    plan: ParsedTransitionPlan;
    signal: AbortSignal;
    delivery: CoordinatorAdvanceDelivery;
    expressionEvaluator?: ExpressionEvaluator;
    minimumInlineOnly?: boolean;
    nativeSourceInventoryOnly?: boolean;
  }>,
) {
  const proposed = input.plan.callableResult;
  if (proposed?.kind !== 'succeeded') return;
  const columns =
    input.minimumInlineOnly === true || input.nativeSourceInventoryOnly === true
      ? 'version.executable_json'
      : 'version.executable_json,run.input_ref';
  const rows = await client.query<{
    executable_json: unknown;
    input_ref: unknown;
  }>(
    `select ${columns} from app.workflow_runs run
       join app.workflow_versions version on version.workspace_id=run.workspace_id
        and version.id=run.workflow_version_id and version.workflow_id=run.workflow_id
       where run.workspace_id=$1 and run.id=$2 and version.id=$3
         and version.schema_version=2 and version.executable_schema_version=3`,
    [input.workspaceId, input.runId, input.workflowVersionId],
  );
  const row = rows.rows[0];
  if (rows.rows.length !== 1 || row === undefined)
    throw new CoordinatorPlanInvalidError();
  const envelope = row.executable_json;
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope)
  )
    throw new CoordinatorPlanInvalidError();
  const graph = Reflect.get(envelope, 'graph') as unknown;
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph))
    throw new CoordinatorPlanInvalidError();
  const declaration = workflowCallableDeclarationSchemaV1.parse(
    Reflect.get(graph, 'callable'),
  );
  const nodes = Reflect.get(graph, 'nodes') as unknown;
  if (!Array.isArray(nodes) || nodes.length > 1_000)
    throw new CoordinatorPlanInvalidError();
  const rootIds = nodes.map((node: unknown) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node))
      throw new CoordinatorPlanInvalidError();
    const id = Reflect.get(node, 'id') as unknown;
    if (typeof id !== 'string') throw new CoordinatorPlanInvalidError();
    return id;
  });
  if (!validateCallableValueV1(declaration.result, proposed.value).ok)
    throw new CoordinatorPlanInvalidError();
  const selector = declaration.resultSelector;
  if (
    input.minimumInlineOnly === true &&
    selector.kind !== 'literal' &&
    !(selector.kind === 'run_input' && selector.path === '$') &&
    !(selector.kind === 'node_output' && selector.path === '$')
  )
    throw new Error(
      'Native result expression/path preparation is not implemented',
    );
  let nodeIds: readonly string[] = [];
  if (selector.kind === 'node_output') nodeIds = [selector.nodeId];
  if (selector.kind === 'expression') {
    const inspected = inspectExpressionNodeOutputReferences(
      selector.expression,
      selector.policyVersion,
    );
    if (inspected.kind !== 'valid' || input.expressionEvaluator === undefined)
      throw new CoordinatorPlanInvalidError();
    nodeIds = inspected.nodeIds === 'all' ? rootIds : inspected.nodeIds;
  }
  const sources = nodeIds.map((nodeId) => {
    const matches = input.plan.checkpoint.invocations.filter(
      (entry) => entry.nodeId === nodeId && entry.status === 'succeeded',
    );
    const entry = matches[0];
    if (
      !rootIds.includes(nodeId) ||
      matches.length !== 1 ||
      entry?.output === undefined
    )
      throw new CoordinatorPlanInvalidError();
    return { invocationKey: entry.invocationKey, output: entry.output, nodeId };
  });
  const expectedSources = sources.map(({ invocationKey, output }) => ({
    invocationKey,
    output,
  }));
  if (
    serializeWorkflowExecutionJsonValueV3(expectedSources) !==
    serializeWorkflowExecutionJsonValueV3(proposed.sources)
  )
    throw new CoordinatorPlanInvalidError();
  const nodeOutputs: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  if (
    input.minimumInlineOnly === true ||
    input.nativeSourceInventoryOnly === true
  ) {
    if (selector.kind === 'literal')
      return Object.freeze({
        declaration,
        proposedValue: proposed.value,
        context: { runInput: null, nodeOutputs },
      });
    const selection = {
      owner: {
        workspaceId: input.workspaceId,
        runId: input.runId,
        workflowVersionId: input.workflowVersionId,
        expectedRevision: input.plan.expectedRevision,
        delivery: input.delivery,
      },
      demand: {
        expectedRevision: input.plan.expectedRevision,
        resultSelector: selector,
        requiresRunInput:
          selector.kind === 'run_input' || selector.kind === 'expression',
        sources,
      },
    };
    if (input.nativeSourceInventoryOnly === true)
      return Object.freeze({
        declaration,
        proposedValue: proposed.value,
        nativeDemand: selection.demand,
        nativeOwner: selection.owner,
      });
    const context = await loadNativeCoordinatorResultContext(client, selection);
    return Object.freeze({
      declaration,
      proposedValue: proposed.value,
      context,
    });
  }
  const facts =
    selector.kind === 'literal' || selector.kind === 'run_input'
      ? []
      : await loadCoordinatorCallFacts(client, input.runId);
  const material = await loadCoordinatorCallableMaterials(client, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    executableJson: envelope,
    inputRef: row.input_ref,
    facts,
    consumer: {
      workspaceId: input.workspaceId,
      runId: input.runId,
      workflowVersionId: input.workflowVersionId,
      expectedRevision: input.plan.expectedRevision,
      delivery: input.delivery,
    },
  });
  for (const source of sources) {
    const matching =
      material?.outputs.filter(
        ({ invocationKey }) => invocationKey === source.invocationKey,
      ) ?? [];
    const descriptor = matching[0];
    if (
      matching.length !== 1 ||
      descriptor === undefined ||
      serializeWorkflowExecutionJsonValueV3(descriptor.output) !==
        serializeWorkflowExecutionJsonValueV3(source.output)
    )
      throw new CoordinatorPlanInvalidError();
    nodeOutputs[source.nodeId] = descriptor.value as JsonValue;
  }
  return Object.freeze({
    declaration,
    proposedValue: proposed.value,
    context: {
      runInput: (material?.runInput ?? null) as JsonValue,
      nodeOutputs,
    },
  });
}

/** Detached material is not commit authority: the protected writer rederives it. */
export async function verifyCoordinatorCallResultAuthentication(
  prepared: NonNullable<
    Awaited<ReturnType<typeof loadCoordinatorCallResultAuthentication>>
  >,
  signal: AbortSignal,
  expressionEvaluator?: ExpressionEvaluator,
  nativeContext?: Readonly<{
    runInput: JsonValue;
    nodeOutputs: Readonly<Record<string, JsonValue>>;
  }>,
): Promise<JsonValue> {
  const context = 'nativeDemand' in prepared ? nativeContext : prepared.context;
  if (context === undefined) throw new CoordinatorPlanInvalidError();
  const selected = await resolveValueSource(
    prepared.declaration.resultSelector,
    context,
    expressionEvaluator,
    signal,
  );
  if (
    selected.kind !== 'value' ||
    !validateCallableValueV1(prepared.declaration.result, selected.value).ok ||
    serializeWorkflowExecutionJsonValueV3(selected.value) !==
      serializeWorkflowExecutionJsonValueV3(prepared.proposedValue)
  )
    throw new CoordinatorPlanInvalidError();
  return selected.value;
}

/** Existing focused interface; actual commit composition releases its read first. */
export async function authenticateCoordinatorCallResult(
  client: PoolClient,
  input: Parameters<typeof loadCoordinatorCallResultAuthentication>[1],
): Promise<void> {
  const prepared = await loadCoordinatorCallResultAuthentication(client, input);
  if (prepared !== undefined)
    await verifyCoordinatorCallResultAuthentication(
      prepared,
      input.signal,
      input.expressionEvaluator,
    );
}
