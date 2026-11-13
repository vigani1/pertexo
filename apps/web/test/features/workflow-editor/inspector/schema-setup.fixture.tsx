// Test-only harnesses for the schema-drawn step setup.
import { useState } from 'react';
import { vi } from 'vitest';
import { SchemaFieldList } from '@/features/workflow-editor/components/inspector/fields/schema-list';
import { SchemaUnionSetup } from '@/features/workflow-editor/components/inspector/fields/union-setup';
import { startingConfig } from '@/features/workflow-editor/model/graph/starting-config';
import {
  coveredProperties,
  schemaFields,
  schemaPropertyCount,
  type NodeConfig,
} from '@/features/workflow-editor/model/inspector/draft';
import type { NodeFormApi } from '@/features/workflow-editor/model/inspector/node-form';
import { readSchemaUnion } from '@/features/workflow-editor/model/inspector/schema-union';
import { browserDefinitions } from '../../../support/fixtures/node-catalog';

const catalog = browserDefinitions();

function definitionOf(key: string) {
  const definition = catalog.find((item) => item.definition.key === key);
  if (definition === undefined) throw new Error(`No ${key} in the catalog`);
  return definition;
}

/** The setup a person sees for a new step, with what it stores. */
export function NewStep({ stepKey }: Readonly<{ stepKey: string }>) {
  const definition = definitionOf(stepKey);
  const [config, setConfig] = useState<NodeConfig>(() =>
    startingConfig(definition, []),
  );
  const form: NodeFormApi = {
    nodeId: 'step',
    editable: true,
    reportScratch: vi.fn(),
    commit: (update) => {
      setConfig((current) => {
        const node = {
          id: 'step',
          definition: definition.definition,
          configVersion: 1,
          position: { x: 0, y: 0 },
          config: current,
          inputMappings: {},
          connectionRefs: {},
        };
        return (
          (typeof update === 'function' ? update(node) : update).config ??
          current
        );
      });
    },
  };
  const union = readSchemaUnion(definition.configSchema);
  const fields = schemaFields(definition.configSchema);
  return (
    <>
      {union === undefined ? (
        <SchemaFieldList
          fields={fields}
          config={config}
          form={form}
          jsonOnlySettings={
            schemaPropertyCount(definition.configSchema) >
            coveredProperties(fields)
          }
        />
      ) : (
        <SchemaUnionSetup union={union} config={config} form={form} />
      )}
      <output aria-label="Saved setup">{JSON.stringify(config)}</output>
    </>
  );
}

/** Any schema's fields, with what they store. */
export function Fields({
  schema,
  start = {},
}: Readonly<{ schema: unknown; start?: NodeConfig }>) {
  const [config, setConfig] = useState<NodeConfig>(start);
  const fields = schemaFields(schema);
  const form: NodeFormApi = {
    nodeId: 'step',
    editable: true,
    reportScratch: vi.fn(),
    commit: (update) => {
      setConfig((current) => {
        const next =
          typeof update === 'function'
            ? update({
                id: 'step',
                definition: { key: 'partner.step', version: 1 },
                configVersion: 1,
                position: { x: 0, y: 0 },
                config: current,
                inputMappings: {},
                connectionRefs: {},
              })
            : update;
        return next.config ?? current;
      });
    },
  };
  return (
    <>
      <SchemaFieldList
        fields={fields}
        config={config}
        form={form}
        jsonOnlySettings={
          schemaPropertyCount(schema) > coveredProperties(fields)
        }
      />
      <output aria-label="Saved setup">{JSON.stringify(config)}</output>
    </>
  );
}
