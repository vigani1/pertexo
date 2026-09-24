import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { Connection } from '@xyflow/react';
import { LinkIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { findDefinition, stepTitle } from '../../model/graph-adapter';
import { ChoiceSelect } from './choice-select';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

/**
 * Connections into this step, with a keyboard way to add one: the canvas
 * drag is never the only way to wire steps.
 */
export function IncomingConnections({
  node,
  graph,
  definitions,
  editable,
  onConnect,
  onRemoveEdge,
}: Readonly<{
  node: WorkflowNode;
  graph: WorkflowGraphContract;
  definitions: readonly NodeDefinitionCatalogItem[];
  editable: boolean;
  onConnect: (connection: Connection) => void;
  onRemoveEdge: (edgeId: string) => void;
}>) {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [sourcePort, setSourcePort] = useState<string | null>(null);
  const [targetPort, setTargetPort] = useState<string | null>(null);
  const titles = new Map(
    graph.nodes.map((candidate) => [candidate.id, stepTitle(candidate)]),
  );
  const incoming = graph.edges.filter((edge) => edge.target.nodeId === node.id);
  const source = graph.nodes.find((candidate) => candidate.id === sourceId);
  const sourcePorts =
    source === undefined
      ? []
      : (findDefinition(definitions, source)?.ports.outputs ?? []);
  const targetPorts =
    findDefinition(definitions, node)?.ports.inputs ??
    Object.keys(node.inputMappings);
  const others = graph.nodes.filter((candidate) => candidate.id !== node.id);
  return (
    <section
      aria-labelledby={`incoming-${node.id}`}
      className="flex flex-col gap-3"
    >
      <h3 id={`incoming-${node.id}`} className="text-sm font-semibold">
        Connected from
      </h3>
      {incoming.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing leads into this step yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {incoming.map((edge) => (
            <li key={edge.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {titles.get(edge.source.nodeId) ?? 'A missing step'}
                <span className="font-mono text-xs text-subtle-foreground">
                  {' '}
                  · {edge.source.port} → {edge.target.port}
                </span>
              </span>
              {editable ? (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove connection from ${titles.get(edge.source.nodeId) ?? 'a step'}`}
                  onClick={() => {
                    onRemoveEdge(edge.id);
                  }}
                >
                  <XIcon />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editable && others.length > 0 ? (
        <FieldGroup className="gap-3 rounded-lg border border-white/7 bg-black/18 p-3">
          <Field>
            <FieldLabel htmlFor={`connect-source-${node.id}`}>
              Connect from step
            </FieldLabel>
            <ChoiceSelect
              id={`connect-source-${node.id}`}
              value={sourceId}
              disabled={false}
              choices={[
                { value: null, label: 'Choose a step' },
                ...others.map((candidate) => ({
                  value: candidate.id,
                  label: titles.get(candidate.id) ?? candidate.id,
                })),
              ]}
              onChange={(next) => {
                setSourceId(next);
                setSourcePort(null);
              }}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field>
              <FieldLabel htmlFor={`connect-output-${node.id}`}>
                From output
              </FieldLabel>
              <ChoiceSelect
                id={`connect-output-${node.id}`}
                value={sourcePort}
                disabled={source === undefined}
                choices={[
                  { value: null, label: 'Choose' },
                  ...sourcePorts.map((port) => ({ value: port, label: port })),
                ]}
                onChange={setSourcePort}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`connect-input-${node.id}`}>
                Into input
              </FieldLabel>
              <ChoiceSelect
                id={`connect-input-${node.id}`}
                value={targetPort}
                disabled={false}
                choices={[
                  { value: null, label: 'Choose' },
                  ...targetPorts.map((port) => ({ value: port, label: port })),
                ]}
                onChange={setTargetPort}
              />
            </Field>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-fit"
            disabled={
              sourceId === null || sourcePort === null || targetPort === null
            }
            onClick={() => {
              if (
                sourceId === null ||
                sourcePort === null ||
                targetPort === null
              )
                return;
              onConnect({
                source: sourceId,
                sourceHandle: sourcePort,
                target: node.id,
                targetHandle: targetPort,
              });
              setSourceId(null);
              setSourcePort(null);
            }}
          >
            <LinkIcon data-icon="inline-start" />
            Connect
          </Button>
        </FieldGroup>
      ) : null}
    </section>
  );
}
