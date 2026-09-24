import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { BracesIcon, ListIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { schemaFields } from '../../model/inspector-draft';
import { ConfigJsonEditor } from './config-json-editor';
import { ConnectionSlot } from './connection-slot';
import type { NodeFormApi } from '../../model/node-form';
import { SchemaField } from './schema-field';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

/**
 * Setup: schema-driven controls, connection slots and "Edit as JSON" for
 * everything the controls don't model. Nothing a schema allows is dropped.
 */
export function SetupTab({
  node,
  definition,
  connections,
  workspaceId,
  form,
}: Readonly<{
  node: WorkflowNode;
  definition: NodeDefinitionCatalogItem | undefined;
  connections: readonly ConnectionResponse[];
  workspaceId: string;
  form: NodeFormApi;
}>) {
  const fields = useMemo(
    () => schemaFields(definition?.configSchema),
    [definition?.configSchema],
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
  const propertyCount = schemaPropertyCount(definition?.configSchema);
  const nothingToSet =
    !onlyJson &&
    fields.length === 0 &&
    Object.keys(node.config).length === 0 &&
    propertyCount === 0;
  const showJson = onlyJson || jsonMode;
  return (
    <FieldGroup className="gap-4">
      {showJson ? (
        <ConfigJsonEditor
          config={node.config}
          form={jsonForm}
          description={
            onlyJson
              ? 'This step type isn’t in the catalog, so its setup is kept exactly as it is.'
              : 'Every property is kept, including ones the fields above don’t show.'
          }
        />
      ) : nothingToSet ? (
        <p className="text-sm text-muted-foreground">
          Nothing to set up for this step. Its inputs decide what it does.
        </p>
      ) : (
        <SchemaFieldList
          fields={fields}
          config={node.config}
          form={form}
          jsonOnlySettings={propertyCount > fields.length}
        />
      )}
      {onlyJson ? null : (
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
          workspaceId={workspaceId}
          form={form}
        />
      ))}
    </FieldGroup>
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
