import type {
  SchemaDocument,
  SchemaJson,
} from '../definitions/schema-document.js';
import type { NodeDefinitionRegistration } from './node-execution.types.js';
import { NodeRegistryCompatibilityError } from './node-execution.errors.js';

export interface AssistantFields {
  readonly visible: readonly string[];
  readonly masked?: readonly string[];
  /** HTTP addresses with embedded credentials or query values are masked. */
  readonly addresses?: readonly string[];
  readonly unlisted?: 'visible' | 'masked';
}

export interface AssistantDisclosure {
  readonly config: AssistantFields;
  readonly inputs: AssistantFields;
}

/** Only top-level properties are classified, including those in a union branch. */
export function assistantSchemaFields(schema: SchemaDocument) {
  const names = new Set(Object.keys(objectSchema(schema.properties) ?? {}));
  let additional =
    schema.additionalProperties === true ||
    objectSchema(schema.additionalProperties) !== undefined;
  for (const composition of [schema.anyOf, schema.oneOf, schema.allOf]) {
    if (!Array.isArray(composition)) continue;
    for (const value of composition as readonly SchemaJson[]) {
      const branch = objectSchema(value);
      if (branch === undefined) continue;
      const fields = assistantSchemaFields(branch);
      for (const name of fields.names) names.add(name);
      additional ||= fields.additional;
    }
  }
  return { names, additional };
}

export function validateAssistantDisclosure({
  manifest,
  assistantDisclosure,
}: NodeDefinitionRegistration): void {
  if (assistantDisclosure === undefined) return;
  const { key, version } = manifest.definition;
  const identity = `${key}@${String(version)}`;
  for (const [kind, schema] of [
    ['config', manifest.configSchema],
    ['inputs', manifest.inputSchema],
  ] as const) {
    const { names, additional } = assistantSchemaFields(schema);
    const fields = assistantDisclosure[kind];
    for (const field of [
      ...fields.visible,
      ...(fields.masked ?? []),
      ...(fields.addresses ?? []),
    ])
      if (!names.delete(field))
        throw new NodeRegistryCompatibilityError(
          `Assistant disclosure for ${identity} names an unknown or repeated ${kind} field: ${field}`,
        );
    if (fields.unlisted !== undefined && !additional)
      throw new NodeRegistryCompatibilityError(
        `Assistant disclosure for ${identity} names unlisted ${kind} fields on a closed schema`,
      );
  }
}

function objectSchema(
  value: SchemaJson | undefined,
): SchemaDocument | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return value as SchemaDocument;
  return undefined;
}
