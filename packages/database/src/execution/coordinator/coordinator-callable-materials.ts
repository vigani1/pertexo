import type { PoolClient } from 'pg';
import { workflowCallableDeclarationSchemaV1 } from '@pertexo/workflow-model/callable-graph-contract';
import { inspectExpressionNodeOutputReferences } from '@pertexo/workflow-model/expressions';
import type {
  PersistedWorkflowCallStateV1,
  PersistedWorkflowCheckpointV3,
} from '../../compatibility/persisted-workflow-checkpoint-v3.js';
import { parseStoredExecutionValueV1 } from '../stored-execution-value.js';
import { readWorkflowCallResultReference } from '../workflow-calls/workflow-call-result-reference.js';
import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';

type Output = NonNullable<
  PersistedWorkflowCheckpointV3['invocations'][number]['output']
>;
export type CoordinatorCallableMaterials = Readonly<{
  runInput: unknown;
  outputs: readonly Readonly<{
    invocationKey: string;
    output: Output;
    value: unknown;
  }>[];
}>;

function inlineValue(value: unknown): unknown {
  const reference = parseStoredExecutionValueV1(value);
  if (reference.kind !== 'inline')
    throw new TypeError('Native callable artifact hydration is unavailable');
  return reference.value;
}

/** Inline hydration through existing physical output and protected child-result owners. */
export async function loadCoordinatorCallableMaterials(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    executableJson: unknown;
    inputRef: unknown;
    facts: readonly PersistedWorkflowCallStateV1[];
  }>,
): Promise<CoordinatorCallableMaterials | undefined> {
  const envelope = input.executableJson;
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope)
  )
    throw new CoordinatorRunStateCorruptError();
  const graph = Reflect.get(envelope, 'graph') as unknown;
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph))
    throw new CoordinatorRunStateCorruptError();
  const raw = Reflect.get(graph, 'callable') as unknown;
  if (raw === undefined) return undefined;
  const declaration = workflowCallableDeclarationSchemaV1.parse(raw);
  const selector = declaration.resultSelector;
  if (selector.kind === 'literal') return undefined;
  const runInput =
    selector.kind === 'run_input' || selector.kind === 'expression'
      ? input.inputRef === null
        ? null
        : inlineValue(input.inputRef)
      : null;
  let nodeIds: readonly string[] = [];
  if (selector.kind === 'node_output') nodeIds = [selector.nodeId];
  if (selector.kind === 'expression') {
    const inspection = inspectExpressionNodeOutputReferences(
      selector.expression,
      selector.policyVersion,
    );
    if (inspection.kind !== 'valid')
      throw new CoordinatorRunStateCorruptError();
    if (inspection.nodeIds === 'all') {
      const nodes = Reflect.get(graph, 'nodes') as unknown;
      if (!Array.isArray(nodes) || nodes.length > 1_000)
        throw new CoordinatorRunStateCorruptError();
      nodeIds = nodes.map((node: unknown) => {
        if (node === null || typeof node !== 'object' || Array.isArray(node))
          throw new CoordinatorRunStateCorruptError();
        const id = Reflect.get(node, 'id') as unknown;
        if (typeof id !== 'string') throw new CoordinatorRunStateCorruptError();
        return id;
      });
    } else nodeIds = inspection.nodeIds;
  }
  if (nodeIds.length === 0)
    return Object.freeze({ runInput, outputs: Object.freeze([]) });
  if (nodeIds.length > 1_000) throw new CoordinatorRunStateCorruptError();
  const rows = await client.query<{
    invocation_key: string;
    node_id: string;
    attempt_id: string;
  }>(
    `select node.invocation_key,node.node_id,attempt.id as attempt_id
       from app.node_runs node join app.node_attempts attempt
         on attempt.workspace_id=node.workspace_id and attempt.id=node.current_attempt_id
        and attempt.node_run_id=node.id and attempt.attempt_number=node.current_attempt_number
       where node.workspace_id=$1 and node.workflow_run_id=$2 and node.node_id=any($3::varchar[])
         and node.status='succeeded' and attempt.status='succeeded'
         and node.output_ref=attempt.output_ref
       order by node.invocation_key limit 10001`,
    [input.workspaceId, input.runId, nodeIds],
  );
  if (rows.rows.length > 10_000) throw new CoordinatorRunStateCorruptError();
  const calls = new Set(input.facts.map(({ invocationKey }) => invocationKey));
  const outputs: { invocationKey: string; output: Output; value: unknown }[] =
    [];
  const physical = rows.rows.filter((row) => !calls.has(row.invocation_key));
  const counts = new Map<string, number>();
  for (const row of physical)
    counts.set(row.node_id, (counts.get(row.node_id) ?? 0) + 1);
  // The engine owns the typed ambiguous-source outcome. It needs no hydrated
  // values to reject a selector with more than one successful invocation.
  if ([...counts.values()].some((count) => count > 1))
    return Object.freeze({ runInput, outputs: Object.freeze([]) });
  if (physical.length > 1_000) throw new CoordinatorRunStateCorruptError();
  // Each retained reference has the existing 4 MiB PostgreSQL wire bound;
  // bounded pages avoid materializing every value in one query result.
  for (let offset = 0; offset < physical.length; offset += 16) {
    const page = physical.slice(offset, offset + 16);
    const values = await client.query<{
      attempt_id: string;
      output_ref: unknown;
    }>(
      `select attempt.id as attempt_id,attempt.output_ref from app.node_attempts attempt
         join app.node_runs node on node.workspace_id=attempt.workspace_id and node.current_attempt_id=attempt.id
          and node.id=attempt.node_run_id and node.current_attempt_number=attempt.attempt_number
         where node.workspace_id=$1 and node.workflow_run_id=$2 and attempt.id=any($3::uuid[])
           and node.status='succeeded' and attempt.status='succeeded' and node.output_ref=attempt.output_ref`,
      [
        input.workspaceId,
        input.runId,
        page.map(({ attempt_id }) => attempt_id),
      ],
    );
    if (values.rows.length !== page.length)
      throw new CoordinatorRunStateCorruptError();
    for (const row of page) {
      const value = values.rows.find(
        ({ attempt_id }) => attempt_id === row.attempt_id,
      );
      if (value === undefined) throw new CoordinatorRunStateCorruptError();
      const reference = parseStoredExecutionValueV1(value.output_ref);
      outputs.push({
        invocationKey: row.invocation_key,
        output:
          reference.kind === 'inline'
            ? { kind: 'inline', attemptId: row.attempt_id }
            : { kind: 'artifact', artifactId: reference.artifactId },
        value: inlineValue(reference),
      });
    }
  }
  for (const fact of input.facts) {
    if (
      fact.status !== 'settled' ||
      fact.childStatus !== 'succeeded' ||
      !nodeIds.includes(fact.nodeId)
    )
      continue;
    const reference = await readWorkflowCallResultReference(client, {
      workspaceId: input.workspaceId,
      parentRunId: input.runId,
      invocationKey: fact.invocationKey,
      childRunId: fact.childRunId,
    });
    outputs.push({
      invocationKey: fact.invocationKey,
      output: {
        kind: 'workflow_call',
        invocationKey: fact.invocationKey,
        childRunId: fact.childRunId,
      },
      value: inlineValue(JSON.parse(reference) as unknown),
    });
  }
  return Object.freeze({
    runInput,
    outputs: Object.freeze(outputs.map((value) => Object.freeze(value))),
  });
}
