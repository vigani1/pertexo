import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { BracesIcon, ListIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { schemaFields, type NodeConfig } from '../../model/inspector-draft';
import {
  readScheduleSchema,
  type ScheduleSchema,
} from '../../model/schedule-draft';
import { ConfigJsonEditor } from './config-json-editor';
import { ConnectionSlot } from './connection-slot';
import { ScheduleBuilder } from './schedule/schedule-builder';
import type { NodeFormApi } from '../../model/node-form';
import { SchemaField } from './schema-field';

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
  onOpenInputs,
}: Readonly<{
  node: WorkflowNode;
  definition: NodeDefinitionCatalogItem | undefined;
  connections: readonly ConnectionResponse[];
  form: NodeFormApi;
  /** Shows the Inputs tab, where a step with no setup is decided. */
  onOpenInputs: () => void;
}>) {
  const fields = useMemo(
    () => schemaFields(definition?.configSchema),
    [definition?.configSchema],
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
          config={node.config}
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
  config,
  configSchema,
  fields,
  scheduleSchema,
  form,
}: Readonly<{
  config: NodeConfig;
  configSchema: unknown;
  fields: ReturnType<typeof schemaFields>;
  scheduleSchema: ScheduleSchema | undefined;
  form: NodeFormApi;
}>) {
  if (scheduleSchema !== undefined)
    return (
      <ScheduleBuilder config={config} schema={scheduleSchema} form={form} />
    );
  const propertyCount = schemaPropertyCount(configSchema);
  return (
    <SchemaFieldList
      fields={fields}
      config={config}
      form={form}
      jsonOnlySettings={propertyCount > fields.length}
    />
  );
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
