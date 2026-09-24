import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { useEditorStore } from '../../model/editor-store-context';
import { connectWorkflowNodes } from '../../model/graph-adapter';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

export function GraphEdgeControls({
  node,
  graph,
  definitions,
  definition,
}: Readonly<{
  node: WorkflowNode;
  graph: WorkflowGraphContract;
  definitions: readonly NodeDefinitionCatalogItem[];
  definition?: NodeDefinitionCatalogItem;
}>) {
  const transact = useEditorStore((state) => state.transact);
  const [sourceNodeId, setSourceNodeId] = useState('');
  const [sourcePort, setSourcePort] = useState('');
  const [targetPort, setTargetPort] = useState('');
  const sourceNode = graph.nodes.find(
    (candidate) => candidate.id === sourceNodeId,
  );
  const sourceDefinition = definitions.find(
    (candidate) =>
      candidate.definition.key === sourceNode?.definition.key &&
      candidate.definition.version === sourceNode.definition.version,
  );

  function connect() {
    const next = connectWorkflowNodes(graph, {
      source: sourceNodeId,
      sourceHandle: sourcePort,
      target: node.id,
      targetHandle: targetPort,
    });
    if (next !== null) transact(next);
  }

  return (
    <FieldGroup className="rounded-lg border border-white/8 bg-black/15 p-3">
      <Field>
        <FieldLabel htmlFor={`source-node-${node.id}`}>
          Connect from node
        </FieldLabel>
        <select
          id={`source-node-${node.id}`}
          name="sourceNode"
          autoComplete="off"
          className="recessed-control h-10 rounded-lg border px-3 text-base"
          value={sourceNodeId}
          onChange={(event) => {
            setSourceNodeId(event.currentTarget.value);
            setSourcePort('');
          }}
        >
          <option value="">Choose a source node</option>
          {graph.nodes
            .filter((candidate) => candidate.id !== node.id)
            .map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label ?? candidate.definition.key}
              </option>
            ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`source-port-${node.id}`}>
          Source output
        </FieldLabel>
        <select
          id={`source-port-${node.id}`}
          name="sourcePort"
          autoComplete="off"
          className="recessed-control h-10 rounded-lg border px-3 text-base"
          value={sourcePort}
          onChange={(event) => {
            setSourcePort(event.currentTarget.value);
          }}
        >
          <option value="">Choose an output</option>
          {(sourceDefinition?.ports.outputs ?? []).map((port) => (
            <option key={port} value={port}>
              {port}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`target-port-${node.id}`}>Target input</FieldLabel>
        <select
          id={`target-port-${node.id}`}
          name="targetPort"
          autoComplete="off"
          className="recessed-control h-10 rounded-lg border px-3 text-base"
          value={targetPort}
          onChange={(event) => {
            setTargetPort(event.currentTarget.value);
          }}
        >
          <option value="">Choose an input</option>
          {(definition?.ports.inputs ?? Object.keys(node.inputMappings)).map(
            (port) => (
              <option key={port} value={port}>
                {port}
              </option>
            ),
          )}
        </select>
      </Field>
      <Button
        type="button"
        variant="outline"
        disabled={sourceNodeId === '' || sourcePort === '' || targetPort === ''}
        onClick={connect}
      >
        Connect nodes
      </Button>
    </FieldGroup>
  );
}
