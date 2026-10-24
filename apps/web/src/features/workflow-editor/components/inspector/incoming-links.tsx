import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import type { Connection } from '@xyflow/react';
import { LinkIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { findDefinition, stepTitle } from '../../model/graph/adapter';
import type { GraphLevel, WorkflowNode } from '../../model/graph/scopes';
import { portName } from '@/features/catalog/presentation.public';
import { ChoiceSelect } from './fields/choice-select';

/**
 * Links into this step, kept apart from its input mapping: wiring
 * decides when the step runs, inputs decide what it gets. "Link a step"
 * opens a keyboard way to add one, so the canvas drag is never the only
 * way to wire steps. Only steps on the same level (the workflow, or the
 * same For each body) are offered.
 */
export function IncomingLinks({
  node,
  graph,
  definitions,
  editable,
  onConnect,
  onRemoveEdge,
}: Readonly<{
  node: WorkflowNode;
  graph: GraphLevel;
  definitions: readonly NodeDefinitionCatalogItem[];
  editable: boolean;
  onConnect: (link: Connection) => void;
  onRemoveEdge: (edgeId: string) => void;
}>) {
  const [wiring, setWiring] = useState(false);
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
      className="flex flex-col gap-3 border-t border-surface-ink/7 pt-4"
    >
      <div>
        <h3 id={`incoming-${node.id}`} className="text-sm font-semibold">
          Linked from
        </h3>
        <p className="mt-0.5 text-xs text-subtle-foreground">
          Wiring decides when this step runs. Its inputs above decide what it
          gets.
        </p>
      </div>
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
                  · {portName(edge.source.port)} → {portName(edge.target.port)}
                </span>
              </span>
              {editable ? (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove link from ${titles.get(edge.source.nodeId) ?? 'a step'}`}
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
      {editable && others.length > 0 && !wiring ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-fit"
          onClick={() => {
            setWiring(true);
          }}
        >
          <LinkIcon data-icon="inline-start" />
          Link a step
        </Button>
      ) : null}
      {editable && others.length > 0 && wiring ? (
        <LinkStepForm
          nodeId={node.id}
          choices={{
            others,
            titles,
            sourcePorts,
            targetPorts,
            sourceAvailable: source !== undefined,
          }}
          selection={{ sourceId, sourcePort, targetPort }}
          commands={{
            setSourceId,
            setSourcePort,
            setTargetPort,
            setWiring,
            onConnect,
          }}
        />
      ) : null}
    </section>
  );
}

type LinkStepFormProps = Readonly<{
  nodeId: string;
  choices: Readonly<{
    others: readonly WorkflowNode[];
    titles: ReadonlyMap<string, string>;
    sourcePorts: readonly string[];
    targetPorts: readonly string[];
    sourceAvailable: boolean;
  }>;
  selection: Readonly<{
    sourceId: string | null;
    sourcePort: string | null;
    targetPort: string | null;
  }>;
  commands: Readonly<{
    setSourceId: (value: string | null) => void;
    setSourcePort: (value: string | null) => void;
    setTargetPort: (value: string | null) => void;
    setWiring: (value: boolean) => void;
    onConnect: (link: Connection) => void;
  }>;
}>;
function LinkStepForm({
  nodeId,
  choices,
  selection,
  commands,
}: LinkStepFormProps) {
  const { others, titles, sourcePorts, targetPorts, sourceAvailable } = choices;
  const { sourceId, sourcePort, targetPort } = selection;
  const { setSourceId, setSourcePort, setTargetPort, setWiring, onConnect } =
    commands;
  const linkIncomplete =
    sourceId === null || sourcePort === null || targetPort === null;
  return (
    <FieldGroup className="gap-3 rounded-lg border border-surface-ink/7 bg-recess-ink/18 p-3">
      <Field>
        <FieldLabel htmlFor={`link-source-${nodeId}`}>
          Link from step
        </FieldLabel>
        <ChoiceSelect
          id={`link-source-${nodeId}`}
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
          <FieldLabel htmlFor={`link-output-${nodeId}`}>From output</FieldLabel>
          <ChoiceSelect
            id={`link-output-${nodeId}`}
            value={sourcePort}
            disabled={!sourceAvailable}
            choices={[
              { value: null, label: 'Choose' },
              ...sourcePorts.map((port) => ({ value: port, label: port })),
            ]}
            onChange={setSourcePort}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`link-input-${nodeId}`}>Into input</FieldLabel>
          <ChoiceSelect
            id={`link-input-${nodeId}`}
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
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={linkIncomplete}
          onClick={() => {
            if (linkIncomplete) return;
            onConnect({
              source: sourceId,
              sourceHandle: sourcePort,
              target: nodeId,
              targetHandle: targetPort,
            });
            setSourceId(null);
            setSourcePort(null);
            setWiring(false);
          }}
        >
          <LinkIcon data-icon="inline-start" />
          Link
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setWiring(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </FieldGroup>
  );
}
