import { z } from 'zod';
import type { NodeManifest } from './catalog.js';
import type { SchemaDocument } from './schema-document.js';

const fieldsSchema = z
  .array(z.string().min(1))
  .min(1)
  .refine((fields) => new Set(fields).size === fields.length)
  .readonly();

export const agentToolPolicySchema = z
  .strictObject({
    effect: z.literal('read'),
    inputFields: fieldsSchema,
    result: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('bounded_output') }).readonly(),
      z
        .strictObject({ kind: z.literal('fields'), fields: fieldsSchema })
        .readonly(),
    ]),
  })
  .readonly();

export type AgentToolPolicy = z.output<typeof agentToolPolicySchema>;

export function hasValidAgentToolFields(manifest: NodeManifest): boolean {
  const { agentTool, inputSchema, outputSchema } = manifest;
  if (agentTool === undefined) return true;
  return (
    fieldsExistInSchema(agentTool.inputFields, inputSchema) &&
    (agentTool.result.kind === 'bounded_output' ||
      fieldsExistInSchema(agentTool.result.fields, outputSchema))
  );
}

function fieldsExistInSchema(
  fields: readonly string[],
  schema: SchemaDocument,
): boolean {
  const { properties } = schema;
  return (
    schema.type === 'object' &&
    properties !== null &&
    typeof properties === 'object' &&
    !Array.isArray(properties) &&
    fields.every((field) => Object.hasOwn(properties, field))
  );
}
