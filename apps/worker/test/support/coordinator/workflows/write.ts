import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import type { CallableDeclaration } from '@pertexo/workflow-model';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import type {
  Query,
  WorkflowIdentity,
  StructuredForEachKind,
} from './contract.js';
import { setNode } from './nodes.js';
import { linearGraph } from './graphs/basic.js';
import { forEachGraph } from './graphs/loops.js';

export async function insertCompiledWorkflow(
  query: Query,
  input: Readonly<{
    actorId: string;
    graph: unknown;
    identity: WorkflowIdentity;
    name: string;
    catalog: Parameters<typeof composeExecutableCatalog>[0];
    workspaceId: string;
  }>,
) {
  const executable = buildWorkflowExecutable({
    graph: input.graph,
    catalog: composeExecutableCatalog(input.catalog),
  });
  await query(
    `insert into app.workflows (id, workspace_id, name, created_by)
       values ($1, $2, $3, $4)`,
    [input.identity.workflowId, input.workspaceId, input.name, input.actorId],
  );
  await query(
    `insert into app.workflow_versions (
       id, workspace_id, workflow_id, version_number,
       graph_json, checksum, executable_json,
       published_by
     ) values ($1, $2, $3, 1, $4::jsonb, $5, $6::jsonb, $7)`,
    [
      input.identity.workflowVersionId,
      input.workspaceId,
      input.identity.workflowId,
      JSON.stringify(input.graph),
      executable.checksum,
      JSON.stringify(executable.envelope),
      input.actorId,
    ],
  );
  return executable;
}

export function seedCallableWorkflow(
  query: Query,
  input: Readonly<{
    actorId: string;
    workspaceId: string;
    identity: WorkflowIdentity;
    callable: CallableDeclaration;
  }>,
) {
  return insertCompiledWorkflow(query, {
    ...input,
    graph: { ...linearGraph(), callable: input.callable },
    name: 'Callable contract proof',
    catalog: PLATFORM_NODE_CATALOG,
  });
}

export async function seedSerialForEachWorkflow(
  query: Query,
  input: Readonly<{
    actorId: string;
    workspaceId: string;
    identity: WorkflowIdentity;
  }>,
): Promise<void> {
  await insertCompiledWorkflow(query, {
    ...input,
    graph: forEachGraph(1),
    name: 'Serial For Each continuation proof',
    catalog: PLATFORM_NODE_CATALOG,
  });
}

export async function seedStructuredForEachWorkflow(
  query: Query,
  input: Readonly<{
    actorId: string;
    workspaceId: string;
    identity: WorkflowIdentity;
    kind: StructuredForEachKind;
  }>,
): Promise<void> {
  const graph = structuredClone(forEachGraph(1));
  const loop = graph.nodes.find((node) => node.id === 'for-each');
  if (loop === undefined || !('structured' in loop))
    throw new Error('For Each fixture body missing');
  const body = loop.structured.body;
  const first = body.nodes.find((node) => node.id === 'body-map');
  if (first === undefined) throw new Error('For Each fixture node missing');
  if (input.kind === 'nested') {
    Object.assign(first, {
      definition: { key: 'core.foreach', version: 1 },
      inputMappings: { items: { kind: 'literal', value: ['inner'] } },
      structured: {
        kind: 'for_each',
        maxIterations: 1,
        maxConcurrency: 1,
        body: {
          settings: {},
          inputPorts: ['item', 'ordinal'],
          outputPorts: ['result'],
          nodes: [
            {
              ...setNode('nested-body', 0),
              inputMappings: {
                value: { kind: 'structured_input', port: 'item', path: '$' },
              },
            },
          ],
          edges: [],
        },
      },
    });
    body.nodes = [first];
    body.edges = [];
  } else {
    Object.assign(first, {
      definition: {
        key: input.kind === 'condition' ? 'core.condition' : 'core.switch',
        version: 1,
      },
      config:
        input.kind === 'condition'
          ? {}
          : { cases: [{ id: 'case-01', equals: 'selected' }] },
      inputMappings:
        input.kind === 'condition'
          ? { condition: { kind: 'literal', value: true } }
          : { value: { kind: 'literal', value: 'selected' } },
    });
    const edge = body.edges[0];
    if (edge === undefined) throw new Error('For Each fixture edge missing');
    edge.source.port = input.kind === 'condition' ? 'true' : 'case-01';
  }
  await insertCompiledWorkflow(query, {
    actorId: input.actorId,
    workspaceId: input.workspaceId,
    identity: input.identity,
    graph,
    name: `Structured ${input.kind} For Each continuation proof`,
    catalog: PLATFORM_NODE_CATALOG,
  });
}
