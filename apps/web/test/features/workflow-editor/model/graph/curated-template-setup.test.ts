import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import { isRecord } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';
import { reopenFieldValue } from '@/features/workflow-editor/model/inspector/field-text';
import {
  readFieldValue,
  schemaFields,
  withFieldValue,
  type NodeConfig,
} from '@/features/workflow-editor/model/inspector/draft';
import {
  readSchemaUnion,
  unionFields,
} from '@/features/workflow-editor/model/inspector/schema-union';
import { browserDefinitions } from '../../../../support/fixtures/node-catalog';

type StoredStep = Readonly<{
  id: string;
  definition: Readonly<{ key: string; version: number }>;
  config: NodeConfig;
}>;

/** Every step in a graph, For each bodies included. */
function stepsOf(graph: unknown): StoredStep[] {
  if (!isRecord(graph) || !Array.isArray(graph.nodes)) return [];
  return graph.nodes.flatMap((node: unknown) => {
    if (!isRecord(node) || !isRecord(node.definition) || !isRecord(node.config))
      return [];
    const step = node as unknown as StoredStep;
    return [step, ...stepsOf(node.structured)];
  });
}

// Opening a saved workflow and saving it untouched must not change its
// setup: each stored value goes through the field that draws it (the text
// a typed field shows and what that text saves as, a select's choices, a
// switch's on/off) and the step's setup comes back exactly as stored. A
// template value no field can show as stored fails here.
describe('curated templates in the schema-drawn setup', () => {
  const catalog = browserDefinitions();
  const steps = CURATED_WORKFLOW_TEMPLATES.flatMap((template) =>
    stepsOf(template.manifest.graph).map(
      (step) => [`${template.templateId} ${step.id}`, step] as const,
    ),
  );

  it('has steps to check', () => {
    expect(steps.length).toBeGreaterThan(CURATED_WORKFLOW_TEMPLATES.length);
  });

  it.each(steps)('opens %s without a setup change', (_, step) => {
    const definition = catalog.find(
      (item) =>
        item.definition.key === step.definition.key &&
        item.definition.version === step.definition.version,
    );
    expect(definition).toBeDefined();
    const union = readSchemaUnion(definition?.configSchema);
    if (union !== undefined)
      expect(union.choices.map(({ value }) => value)).toContain(
        step.config[union.key],
      );
    const fields =
      union === undefined
        ? schemaFields(definition?.configSchema)
        : unionFields(union, step.config[union.key]);
    const reopened = fields.reduce<NodeConfig>(
      (config, field) => {
        const stored = readFieldValue(step.config, field);
        if (stored === undefined) return config;
        const shown = reopenFieldValue(field, stored);
        expect(shown, `${step.id} ${field.key}`).toEqual({
          ok: true,
          value: stored,
        });
        return shown.ok ? withFieldValue(config, field, shown.value) : config;
      },
      withoutFields(step.config, fields),
    );
    expect(reopened).toEqual(step.config);
  });
});

/** The setup without what the fields draw: what only Edit as JSON shows. */
function withoutFields(
  config: NodeConfig,
  fields: ReturnType<typeof schemaFields>,
): NodeConfig {
  return fields.reduce<NodeConfig>(
    (rest, field) => withFieldValue(rest, field, undefined),
    config,
  );
}
