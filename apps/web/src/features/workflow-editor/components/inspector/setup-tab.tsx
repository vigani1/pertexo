import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { BracesIcon, ListIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { schemaFields } from '../../model/inspector-draft';
import { stepTitle } from '../../model/graph-adapter';
import {
  readParallelBranches,
  readSwitchCases,
  readValidateRules,
} from '../../model/setup-builders';
import type { GraphLevel } from '../../model/graph-scopes';
import {
  readScheduleSchema,
  type ScheduleSchema,
} from '../../model/schedule-draft';
import { ConfigJsonEditor } from './config-json-editor';
import { ConnectionSlot } from './connection-slot';
import { ScheduleBuilder } from './schedule/schedule-builder';
import type { NodeFormApi } from '../../model/node-form';
import { SchemaField } from './schema-field';
import { ParallelBranches } from './builders/parallel-branches';
import { SwitchCases } from './builders/switch-cases';
import { ValidateRules } from './builders/validate-rules';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

const SCHEDULE_KEY = 'core.schedule';

/**
 * Setup: schema-driven controls (a rule builder for the Schedule step),
 * connection slots and "Edit as JSON" for everything the controls don't
 * model. Nothing a schema allows is dropped.
 */
export function SetupTab({
  node,
  definition,
  connections,
  form,
  graph,
  onOpenInputs,
}: Readonly<{
  node: WorkflowNode;
  definition: NodeDefinitionCatalogItem | undefined;
  connections: readonly ConnectionResponse[];
  form: NodeFormApi;
  /** The steps around this one and their connections. */
  graph: GraphLevel;
  /** Shows the Inputs tab, where a step with no setup is decided. */
  onOpenInputs: () => void;
}>) {
  const fields = useMemo(
    () => withStepChoices(schemaFields(definition?.configSchema), node, graph),
    [definition?.configSchema, node, graph],
  );
  const scheduleSchema = useMemo(
    () =>
      node.definition.key === SCHEDULE_KEY
        ? readScheduleSchema(definition?.configSchema)
        : undefined,
    [node.definition.key, definition?.configSchema],
  );
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonScratch, setJsonScratch] = useState(false);
  const jsonForm = useMemo<NodeFormApi>(
    () => ({
      ...form,
      reportScratch: (field, scratch) => {
        setJsonScratch(scratch);
        form.reportScratch(field, scratch);
      },
    }),
    [form],
  );
  const onlyJson = definition === undefined;
  const showJson = onlyJson || jsonMode;
  // A step whose schema has nothing to set (Condition, say) is decided by
  // its inputs: point there instead of offering an empty JSON object.
  const nothingToSet =
    !onlyJson &&
    scheduleSchema === undefined &&
    fields.length === 0 &&
    Object.keys(node.config).length === 0 &&
    schemaPropertyCount(definition.configSchema) === 0;
  return (
    <FieldGroup className="gap-4">
      {nothingToSet ? (
        <div className="flex flex-col items-start gap-1.5 text-sm text-muted-foreground">
          <p>
            Nothing to set up here. What this step does comes from its inputs.
          </p>
          <Button type="button" variant="link" onClick={onOpenInputs}>
            Go to Inputs
          </Button>
        </div>
      ) : showJson ? (
        <ConfigJsonEditor
          config={node.config}
          form={jsonForm}
          description={
            onlyJson
              ? 'This step type isn’t in the catalog, so its setup is kept exactly as it is.'
              : 'Every property is kept, including ones the fields above don’t show.'
          }
        />
      ) : (
        <SetupControls
          node={node}
          graph={graph}
          configSchema={definition.configSchema}
          fields={fields}
          scheduleSchema={scheduleSchema}
          form={form}
        />
      )}
      {onlyJson || nothingToSet ? null : (
        <JsonModeToggle
          jsonMode={jsonMode}
          disabled={jsonMode && jsonScratch}
          onToggle={() => {
            setJsonMode((current) => !current);
          }}
        />
      )}
      {(definition?.connectionRequirements ?? []).map((requirement) => (
        <ConnectionSlot
          key={requirement}
          requirement={requirement}
          selectedId={node.connectionRefs[requirement]}
          connections={connections}
          form={form}
        />
      ))}
    </FieldGroup>
  );
}

/** The controls for a catalog step's setup, when it isn't shown as JSON. */
function SetupControls({
  node,
  graph,
  configSchema,
  fields,
  scheduleSchema,
  form,
}: Readonly<{
  node: WorkflowNode;
  graph: GraphLevel;
  configSchema: unknown;
  fields: ReturnType<typeof schemaFields>;
  scheduleSchema: ScheduleSchema | undefined;
  form: NodeFormApi;
}>) {
  const { config } = node;
  if (scheduleSchema !== undefined)
    return (
      <ScheduleBuilder config={config} schema={scheduleSchema} form={form} />
    );
  const list = listBuilder(node, graph, form);
  const propertyCount = schemaPropertyCount(configSchema);
  return (
    <>
      {list?.control}
      <SchemaFieldList
        fields={fields}
        config={config}
        form={form}
        jsonOnlySettings={propertyCount > fields.length + (list?.covers ?? 0)}
      />
    </>
  );
}

/**
 * The list a Switch, Parallel or Validate is set up with (cases, branches,
 * rules) as its own builder, when the stored list is one the builder can
 * show without losing anything; otherwise the list stays on JSON.
 */
function listBuilder(
  node: WorkflowNode,
  graph: GraphLevel,
  form: NodeFormApi,
): Readonly<{ control: ReactNode; covers: number }> | undefined {
  const connectedPorts = new Set(
    graph.edges
      .filter((edge) => edge.source.nodeId === node.id)
      .map((edge) => edge.source.port),
  );
  switch (node.definition.key) {
    case 'core.switch': {
      const cases = readSwitchCases(node.config);
      return cases === undefined
        ? undefined
        : {
            control: (
              <SwitchCases
                cases={cases}
                connectedPorts={connectedPorts}
                form={form}
              />
            ),
            covers: 1,
          };
    }
    case 'core.parallel': {
      const branches = readParallelBranches(node.config);
      return branches === undefined
        ? undefined
        : {
            control: (
              <ParallelBranches
                branches={branches}
                connectedPorts={connectedPorts}
                form={form}
              />
            ),
            covers: 1,
          };
    }
    case 'core.validate': {
      const rules = readValidateRules(node.config);
      return rules === undefined
        ? undefined
        : { control: <ValidateRules rules={rules} form={form} />, covers: 1 };
    }
    default:
      return undefined;
  }
}

function SchemaFieldList({
  fields,
  config,
  form,
  jsonOnlySettings,
}: Readonly<{
  fields: ReturnType<typeof schemaFields>;
  config: WorkflowNode['config'];
  form: NodeFormApi;
  /** The schema has properties no field models. */
  jsonOnlySettings: boolean;
}>) {
  return (
    <>
      {fields.map((field) => (
        <SchemaField
          key={field.key}
          field={field}
          config={config}
          form={form}
        />
      ))}
      {jsonOnlySettings ? (
        <p className="text-xs text-subtle-foreground">
          Some settings can only be edited as JSON.
        </p>
      ) : null}
    </>
  );
}

function JsonModeToggle({
  jsonMode,
  disabled,
  onToggle,
}: Readonly<{ jsonMode: boolean; disabled: boolean; onToggle: () => void }>) {
  const Icon = jsonMode ? ListIcon : BracesIcon;
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="w-fit"
      disabled={disabled}
      onClick={onToggle}
    >
      <Icon data-icon="inline-start" />
      {jsonMode ? 'Back to fields' : 'Edit as JSON'}
    </Button>
  );
}

function schemaPropertyCount(schema: unknown): number {
  if (typeof schema !== 'object' || schema === null) return 0;
  const properties: unknown = Reflect.get(schema, 'properties');
  return typeof properties === 'object' && properties !== null
    ? Object.keys(properties).length
    : 0;
}

/**
 * Fields that depend on the steps around this one: a Merge names the
 * Parallel it joins by that step's ID, so the Parallel steps are offered by
 * name; a Parallel runs at most as many branches at once as it has.
 */
function withStepChoices(
  fields: ReturnType<typeof schemaFields>,
  node: WorkflowNode,
  graph: Pick<GraphLevel, 'nodes'>,
): ReturnType<typeof schemaFields> {
  if (node.definition.key === 'core.parallel') {
    const branches = readParallelBranches(node.config)?.length;
    return fields.map((field) =>
      field.key === 'maxConcurrency'
        ? {
            ...field,
            ...(branches === undefined || branches === 0
              ? {}
              : { maximum: branches }),
            description:
              'How many branches run at the same time; the rest wait their turn.',
          }
        : field,
    );
  }
  if (node.definition.key !== 'core.merge') return fields;
  const parallels = graph.nodes.filter(
    (candidate) => candidate.definition.key === 'core.parallel',
  );
  return fields.map((field) =>
    field.key === 'parallelNodeId'
      ? {
          ...field,
          options: parallels.map((parallel) => parallel.id),
          optionLabels: Object.fromEntries(
            parallels.map((parallel) => [parallel.id, stepTitle(parallel)]),
          ),
          description:
            parallels.length === 0
              ? 'Add a Parallel step first; a Merge joins its branches.'
              : 'The Parallel step whose branches this step waits for.',
        }
      : field,
  );
}
