import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import { isRecord } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';
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

// Opening a saved workflow must not change its setup: each step's stored
// values read into the schema-drawn fields and write back unchanged.
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
    for (const field of fields) {
      const value = readFieldValue(step.config, field);
      if (value === undefined) continue;
      expect(withFieldValue(step.config, field, value)).toEqual(step.config);
    }
  });
});
